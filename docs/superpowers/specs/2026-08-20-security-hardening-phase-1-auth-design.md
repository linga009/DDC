# Security & Trust Hardening — Phase 1: Shared-Secret Authentication — Design

> Forward-looking design, written before any implementation — treat the
> open questions section as seriously as the architecture itself.

## Background: the four-phase initiative

The project's dev team flagged four disclosed gaps as caveats: (1) no
authentication or encryption on the coordinator, `swarm-node-agent`, or
`swarm-rpc-server`; (2) the coordinator's `KeywordSafetyClassifier` ships
with zero rules by default; (3) `ReputationTracker` has no sybil-resistance
(plain in-memory `Map`, no endpoint-uniqueness check, churning registration
mints a fresh entry with no eviction — see README's "Known gaming vectors");
(4) `POST /generate`'s node selection is a literal first-match `.find()`
scan with no reputation/load-awareness, despite that data already existing
in the registry.

All four are being fixed as one coordinated initiative, in this order,
because each later phase assumes the earlier ones exist:

1. **Phase 1 (this doc): shared-secret authentication.** Foundational —
   without it, sybil-resistant reputation (Phase 3) and reputation-aware
   selection (Phase 4) are protecting a system anyone can still freely
   impersonate.
2. **Phase 2: a real safety-classifier ruleset.** Independent, cheap.
3. **Phase 3: sybil-resistant reputation.** Only meaningful once nodes
   can't freely re-register under a new identity to escape ejection.
4. **Phase 4: reputation-ranked node selection for `POST /generate`.**
   Narrower than the existing (separate, not-yet-implemented) Phase B
   "dynamic pipeline assembly" design — Phase 4 only picks the best
   *single* already-registered node serving a model; it does not assemble
   multi-node sharded pipelines or introduce Phase B's "launcher" role.

Phases 2–4 each get their own design doc when their turn comes, matching
this project's established pattern for the request-routing initiative's
Phase A/B/C/D specs.

## Goals (Phase 1)

- Require a shared secret on every coordinator endpoint and every
  `swarm-node-agent` endpoint, closing "anyone can register a fake node,
  submit inference requests, or read swarm state."
- No new dependencies: Node.js stdlib `crypto` on the coordinator side, a
  small hand-rolled constant-time comparison in C++ on the node-agent side.
- Keep the browser dashboard usable without becoming a second, parallel
  auth system.

## Non-Goals (Phase 1)

- **Encryption-in-transit in code.** Explored and deliberately rejected:
  the coordinator could get real TLS for free via Node's built-in
  `https`/`tls` module, but `swarm-node-agent`'s hand-rolled C++
  `HttpServer` and `swarm-rpc-server`'s vendored llama.cpp RPC backend
  cannot, without either a new C++ TLS dependency or forking pinned
  vendor code — both bigger, separate decisions. Encrypting only the
  coordinator's own hop would be a lopsided story: the coordinator→
  node-agent hop that actually carries the user's prompt would stay
  cleartext regardless. Instead, all three components get the same
  documented operational mitigation: run them behind an SSH tunnel or
  WireGuard for both auth and encryption when used beyond a single
  trusted machine/LAN. This is a README addition, not code.
- **Per-node individual tokens, issuance, or revocation.** One shared
  secret for the whole swarm, v1. A leaked token means rotating the one
  secret everywhere; per-node tokens are a real improvement but a bigger
  scope, deferred and named here rather than silently promised.
- **`swarm-rpc-server` protocol-level auth.** `ggml_backend_rpc_start_server()`
  has no auth/token/callback parameter in llama.cpp's public API (verified
  against `vendor/llama.cpp/ggml/include/ggml-rpc.h`); adding one means
  forking vendored code this project has never modified before. Out of
  scope for Phase 1 — see the tunnel mitigation above instead.
- **Phases 2–4's actual fixes** (real classifier rules, sybil-resistant
  reputation, reputation-ranked selection) — this doc is Phase 1 only.

## Architecture

### Token model

One secret, `SWARM_AUTH_TOKEN`, set as an environment variable on the
coordinator process and every `swarm-node-agent` process (not a CLI flag —
an env var doesn't show up in `ps`/process-list output on a shared
machine, unlike every other node-agent setting which *is* a CLI flag).
Checked via a standard `Authorization: Bearer <token>` header.

Both the coordinator and node-agent **fail fast at startup** if
`SWARM_AUTH_TOKEN` is unset — no silent unauthenticated fallback. This
matches the project's existing pattern of `swarm-rpc-server` and
`swarm-node-agent` requiring `--port` outright rather than defaulting it.

Comparison is constant-time on both sides (`crypto.timingSafeEqual` in
Node; a small hand-rolled constant-time byte comparison in C++, not a
library — a `==` on secret-derived strings is a timing side-channel).

### Coordinator (`coordinator/src/server.ts`)

Every route requires the token, including `GET /nodes`, `GET /capacity`,
`GET /nodes/locality`, `/classify`, `/generate`, `/nodes/register`,
`/peers/register`, and the reputation endpoints. A missing or wrong token
returns `401` with a JSON error body, checked before any route-specific
logic runs (consistent with this codebase's existing pattern of validating
input shape before touching business logic).

**Exception, and why it isn't actually an exception to "everything
requires the token":** the *static* dashboard shell — `GET /`, `/app.js`,
`/style.css` — stays unauthenticated. These are fixed HTML/CSS/JS source
files with no swarm data embedded in them; requiring a token to fetch the
page that lets you *enter* a token is circular. Every live data call the
dashboard's own JS makes (to `/nodes`, `/capacity`, the `/classify` demo,
etc.) does carry the token, so the actual swarm state stays gated.

`POST /generate`'s existing outbound `fetch()` to a node-agent's
`/complete` gains the same `Authorization` header — the coordinator is
itself a client of the node-agent here, not just a server to the outside
world, and needs to authenticate that hop too.

### Dashboard (`coordinator/src/` static assets served at `/`, `/app.js`, `/style.css`)

Gains a token-entry field. The token is stored in the browser's
`sessionStorage` (cleared when the tab closes — deliberately not
`localStorage`, so a shared/public machine doesn't leave the token sitting
around indefinitely) and attached as `Authorization: Bearer <token>` to
every `fetch()` call the dashboard's JS makes. A `401` response from any
live call re-prompts for the token rather than failing silently.

### Node agent (`core/include/swarm/http_server.h`, `core/src/http_server.cpp`, `core/src/node_agent_main.cpp`)

**Required prerequisite change:** `HttpRequest` currently has only
`method`, `path`, and `body` — the header parser in `http_server.cpp`
(`parseHead`) reads every header line but only ever acts on
`content-length`; every other header, including a future `Authorization`,
is parsed and discarded. This needs a small, focused extension: capture
headers into `HttpRequest` (a simple case-insensitive map is enough — this
server has no need for repeated-header or multi-value semantics) before
any auth check can exist at all.

Once headers are available, both `GET /health` and `POST /complete` check
`Authorization` against `SWARM_AUTH_TOKEN` (read from the environment at
startup, alongside the existing `--model`/`--port`/`--remote`/
`--layer-placement` flag parsing in `node_agent_main.cpp`) before doing
any other work — a missing/wrong token returns `401` with a JSON error
body, matching the existing `400`/`404` JSON-error conventions already in
`HttpServer`.

### `swarm-rpc-server`

No code changes. README gains a recommendation: run it behind an SSH
tunnel (`ssh -L`) or WireGuard when the driver and compute-contributor
machines aren't on a single trusted LAN, for both authentication (the
tunnel's own key-based auth) and encryption — standard, free, no new
dependency, no vendored-code fork.

## Open Questions

- **Token rotation.** With one shared secret and no expiry/rotation
  mechanism, a leaked token requires manually updating the env var on
  every process and restarting them. Acceptable for v1's threat model
  (this is closing "no auth at all," not building a full secrets-
  management system) but worth naming rather than silently omitting.
- **Coordinator↔coordinator peer federation** (`POST /peers/register`
  and related federation traffic) — this doc treats it like any other
  coordinator endpoint (requires the shared token), but a federation of
  multiple independently-operated coordinators each with their *own*
  `SWARM_AUTH_TOKEN` implies those secrets need to be shared out-of-band
  between operators who trust each other, which is a real operational
  question this doc doesn't fully resolve. Flagged for whoever implements
  Phase 1 to revisit if federation-across-operators turns out to be an
  active use case, not just same-operator multi-coordinator setups.

## Testing Considerations (for whenever this gets implemented)

- Coordinator: every route tested both with a valid token (existing
  behavior preserved) and with a missing/wrong token (`401`, no
  side effects — e.g. a `POST /nodes/register` with a bad token must not
  register the node). The dashboard's static-file routes tested
  specifically *without* a token to confirm the circular-dependency
  exception holds.
- Node agent: extend the existing `HttpServer`/`node_agent` test coverage
  (real subprocess spawning, per this project's established practice — see
  Plan 12's whole-branch review) with header-parsing tests for the new
  `Authorization` capture, and auth-check tests on both `/health` and
  `/complete`.
- A live, adversarial check — start a real coordinator and a real
  node-agent, hit them with and without the token — belongs in this
  phase's whole-branch review, matching this project's established,
  consistently bug-finding practice for coordinator/HTTP-surface work.
