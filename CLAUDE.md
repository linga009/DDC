# DDC (swarm-llm) — Project Instructions for Claude Code

A federated, open-source network — Mastodon/Matrix-style, no central authority,
no cryptocurrency/token/donation layer — that pools compute from phones,
desktops, and laptops to run open-weight LLMs too large for any single
device. Full design: [`docs/superpowers/specs/2026-08-14-distributed-llm-inference-design.md`](docs/superpowers/specs/2026-08-14-distributed-llm-inference-design.md).

GitHub: https://github.com/linga009/DDC.git

## Repo Layout

```
core/                    C++17 inference engine (swarm::InferenceEngine) + swarm-cli
  include/swarm/           public headers
  src/                      inference_engine.cpp, main.cpp, rpc_server_main.cpp, speculative.cpp
  tests/                    GoogleTest-style C++ tests, run via ctest
coordinator/             Node.js coordinator service (node registry, capacity, federation, safety, reputation, locality)
  src/                      catalog.ts, main.ts, registry.ts, peer_registry.ts,
                            reputation_tracker.ts, safety_classifier.ts, server.ts
  tests/                    node:test files, one per src file, run via `npm test`
vendor/llama.cpp/        git submodule, pinned to tag b10430 — raw C API only (llama.h,
                          ggml.h, ggml-backend.h, ggml-rpc.h), never the common/ helper lib
docs/superpowers/specs/  design spec(s) — read before starting new feature work
docs/superpowers/plans/  one implementation plan per sub-project, named YYYY-MM-DD-<topic>.md
scripts/                 model-download helper scripts
models/                  gitignored — test GGUF fixtures live here
```

## Tech Stack & Conventions

**C++ core (`core/`):**
- C++17, CMake + Ninja. Windows: MSYS2 UCRT64 toolchain. Build: `cmake -G Ninja -S . -B build && cmake --build build`.
- Use llama.cpp's raw C API only — never `vendor/llama.cpp/common/`. Keeps this project dependency-light and avoids upstream helper-lib churn.
- ccache is wired up (`CCACHE_DIR=/c/Users/User/.ccache`) — reuse it across worktrees instead of cold-rebuilding.
- A persistent local llama.cpp mirror lives at `/c/Users/User/.cache/llama-cpp-mirror` — clone submodules from it in new worktrees, not GitHub, to avoid slow re-clones. See any prior plan's setup steps for the exact commands.
- **Member declaration order is safety-critical**: any vector/string backing a pointer handed to llama.cpp's structs must be declared *before* `model_`/`ctx_` in a class (C++ destroys members in reverse declaration order; `model_`/`ctx_` must outlive anything they reference, so they must be destroyed *first*, meaning declared *last*). This exact bug class has been caught by whole-branch review twice (Plans 2 and, preventively, 4) — do not "fix" a header by reordering without re-checking this.
- Run tests: `cd build && ctest`, or run the built test binary directly (e.g. `./build/core/tests/inference_engine_test.exe`).

**Coordinator (`coordinator/`):**
- Node.js 22.6+, native TypeScript execution — **no build step, no ts-node, zero npm dependencies.** Only `node:http`, `node:test`, `node:assert/strict`, `node:crypto`, native `fetch`, `AbortSignal.timeout`. Do not add an npm dependency without discussing it first — this constraint is deliberate, not an oversight.
- Run tests: `cd coordinator && npm test` (equivalent to `node --test`).
- Start it: `PORT=8080 node src/main.ts`.
- Routing pattern: manual `parts = url.pathname.split("/").filter(Boolean)` + method matching in one big `createServer` handler in `server.ts` — no router library. Follow this pattern for new routes; don't introduce one.
- `NodeRegistry.listActive()` is the single choke point every capacity computation and routing decision reads through (established Plan 3, reaffirmed every plan since). New per-node filtering (reputation, locality) should compose through it, not duplicate its pruning/expiry logic elsewhere.
- **`nodeId` is a deterministic `sha256(lowercased endpoint)` hash, not a random UUID** (Security Hardening Phase 3) — `register()`'s `Map.set()` overwrites the same entry on every re-registration of the same endpoint *string*, so `ReputationTracker` history survives re-registration and expire-then-re-register cycles for a given endpoint string. This is a per-endpoint-string guarantee, not a per-physical-node one: the hash canonicalizes case only, not host aliases, so `127.0.0.1`/`localhost`/`[::1]`/a trailing-dot FQDN pointed at the same machine each get their own clean identity — see README's "Known gaming vectors" before treating `nodeId` as a stable proxy for "this physical node."
- Every piece of state in this service (`NodeRegistry`, `PeerRegistry`, `ReputationTracker`) is **in-memory only, not persisted across restarts** — a deliberate, disclosed limitation, not a gap to silently fix.
- **Shared-secret authentication on every endpoint** (Security Hardening Phase 1, branch `security-phase-1-auth`) — every route requires `Authorization: Bearer <SWARM_AUTH_TOKEN>` except the static dashboard shell (`GET /`, `/app.js`, `/style.css`) and `GET /openapi.json`. The coordinator and `swarm-node-agent` both refuse to start if `SWARM_AUTH_TOKEN` is unset, empty, or contains newlines/leading/trailing whitespace. It is **one secret shared swarm-wide**, not per-node or per-operator credentials, and it is forwarded outbound to node endpoints (`POST /generate`) and peer coordinators (`GET /catalog`) — so the token's exposure surface is every URL any token-holder registers, in cleartext (no TLS). This is disclosed in README's Authentication section, not solved. Self-reported fields (`deviceTier`, `localityGroup`, `servesModel`) are still unverified: auth answers "who may talk to the service", not "is what they claim true". Any change toward per-node/per-operator credentials or TLS is a whole-service threat-model change — raise it explicitly, don't bolt it onto one endpoint.
- README.md documents every endpoint and every disclosed gap/gaming-vector (see its "Known gaming vectors" and "Caveat" sections) — treat gaps as things to *name*, not silently patch, unless asked to actually solve them.

## Development Workflow

This project is built plan-by-plan against the master spec, using the
superpowers skill chain: **brainstorming → writing-plans → subagent-driven-development → finishing-a-development-branch**. Each plan lives in
`docs/superpowers/plans/`, gets its own git worktree at `.worktrees/<plan-name>`,
and goes through this loop per task:

1. Implementer subagent (model tier scaled to task complexity — see
   `subagent-driven-development`'s Model Selection: cheap/haiku for
   fully-specified transcription tasks, standard/sonnet for multi-file
   integration, most-capable for architecture/whole-branch review) writes
   the failing tests, implements, runs the suite, commits, self-reviews.
2. Task reviewer subagent (spec compliance + code quality, its own model
   tier) reviews the diff via `scripts/review-package BASE HEAD`.
3. Fix rounds dispatch ONE subagent per round with the full findings list,
   re-review after.
4. After all tasks: whole-branch review on the most capable available
   model. **For coordinator (HTTP/Node.js) plans, this review must include
   live adversarial probing** — starting the real server and hitting it
   with real HTTP requests, not just reading the diff. Every subtle bug
   found in this project's history (a missing peer-heartbeat route that
   silently killed federation; a `RegExp.test()` `lastIndex`-mutation bug
   that made a safety classifier flip block/allow on identical prompts; a
   `GET /capacity` endpoint left unfiltered by reputation, silently
   breaking federation-wide trust propagation; a `__proto__`-key
   prototype-pollution bug in a Map→object conversion) was found only by
   probing a running instance, never by reading code alone.
5. Merge to `master` (fast-forward when possible), verify tests on master,
   remove the worktree, delete the branch, push.

**When scoping a new plan**, ground it in the *current* state of the files
it touches (read them, don't assume from memory — prior plans' fix rounds
change signatures) and state upfront, explicitly, anything the spec implies
that this repo doesn't have the infrastructure for yet (e.g. Plan 8 and
Plan 9 both had to state, in their own text, that no request-routing/
pipeline-assembly system exists yet, so neither could build the mechanism
the spec's prose implies). Naming a gap in the plan doc and the README is
correct scoping, not a shortfall — see every plan's "What this plan does
not do" section for the established pattern.

## Git Conventions

- **Never add a `Co-Authored-By: Claude` trailer to any commit** — this
  applies to every commit in this repo, including ones made by dispatched
  subagents. State this explicitly in every implementer/fix-subagent
  dispatch prompt; it does not carry over automatically.
- Prefer fast-forward merges to `master` when the branch is up to date;
  rebase/pull first if not.
- Every plan's implementation commits stay on its own worktree branch until
  the whole-branch review passes; only then merge and push.

## After Every Push

Update `CLAUDE.md` (this file) and `README.md` to reflect the current state
— plan roadmap status, new endpoints/interfaces, new conventions or
constraints established during the just-merged work — then commit and push
those doc updates in the same session, before moving on. Don't let this
file drift from what a fresh session would need to know.

## Plan Roadmap

Spec: [`docs/superpowers/specs/2026-08-14-distributed-llm-inference-design.md`](docs/superpowers/specs/2026-08-14-distributed-llm-inference-design.md)

| # | Plan | Status |
|---|------|--------|
| 1 | [Core inference engine](docs/superpowers/plans/2026-08-14-core-inference-engine.md) (single device) | Done |
| 2 | [Multi-node pipeline sharding](docs/superpowers/plans/2026-08-15-multi-node-pipeline-sharding.md) (LAN, RPC) | Done |
| 3 | [Coordinator service](docs/superpowers/plans/2026-08-15-coordinator-service.md) (registry, capacity, catalog gating) | Done |
| 4 | [MoE expert sharding](docs/superpowers/plans/2026-08-15-moe-expert-sharding.md) (per-layer tensor placement) | Done |
| 5 | [Speculative decoding](docs/superpowers/plans/2026-08-15-speculative-decoding.md) | Done |
| 6 | [Federation protocol](docs/superpowers/plans/2026-08-15-federation-protocol.md) (peer registry) | Done |
| 7 | [Safety classifier gateway](docs/superpowers/plans/2026-08-16-safety-classifier-gateway.md) (`/classify`) | Done |
| 8 | [Trust/reputation tracking](docs/superpowers/plans/2026-08-16-trust-reputation-tracking.md) (ejection policy) | Done |
| 9 | [Locality-aware node clustering](docs/superpowers/plans/2026-08-16-locality-clustering.md) | Done |
| 10 | [Web chat/dashboard client](docs/superpowers/plans/2026-08-16-web-chat-client.md) (rescoped from native apps — see plan's Scope correction) | Done |
| 11 | [Developer API](docs/superpowers/plans/2026-08-16-developer-api.md) (OpenAPI spec + typed `SwarmClient`) | Done |

**Plans 1–11 complete.** These built every piece the original spec calls for *except* the ability to actually route a prompt to a real generated response: a working single/multi-node C++ inference engine with speculative decoding and MoE layer placement; a federated Node.js coordinator with node/peer registries, capacity-gated model catalog, a safety-classifier gate (ships with zero rules by default — disclosed, not solved), a reputation/ejection ledger, locality-aware node grouping, a browser dashboard, and a documented+typed developer API. **Phase A (below) closed the routing gap** — see the next section for what changed and what's still missing.

**Plan 10 scope note:** the master spec originally called for native Android/iOS/Linux/Windows/macOS client apps. This dev environment is Windows-only with no mobile/desktop client toolchain installed, and iOS is categorically impossible to build/test without a Mac — when asked, the user chose to rescope Plan 10 to a browser-based dashboard served directly by the coordinator (`GET /`, `/app.js`, `/style.css`) instead. It shows live swarm status and a `/classify` demo; it does not attempt real inference, and its `/classify` demo is backed by the same zero-rule default classifier as the endpoint itself (see the "Coordinator" section below) — both gaps are visibly disclosed in the page's own UI, not just in docs. Native apps remain undesigned and deferred.

### Request routing & pipeline assembly (the initiative after Plans 1–11)

Design: [`docs/superpowers/specs/2026-08-16-request-routing-design.md`](docs/superpowers/specs/2026-08-16-request-routing-design.md) — read this for the full Phase A/B/C/D roadmap and the reasoning behind it (chosen deliberately for genuine multi-node sharding as v1, not a simpler single-node path — this is the project's actual differentiator).

| Phase | Plan | Status |
|---|------|--------|
| A (C++ side) | [swarm-node-agent](docs/superpowers/plans/2026-08-16-swarm-node-agent.md) — a long-lived process wrapping `InferenceEngine` behind a minimal hand-rolled HTTP server (`GET /health`, `POST /complete`) | Done |
| A (coordinator side) | [Coordinator request routing](docs/superpowers/plans/2026-08-16-coordinator-request-routing.md) — `POST /generate`: classify → find a node with a matching `servesModel` → forward → respond | Done |
| B | [Dynamic pipeline assembly](docs/superpowers/specs/2026-08-16-phase-b-dynamic-pipeline-assembly-design.md) (which nodes form a pipeline, chosen live from the registry/reputation/locality data every prior plan built) | Design written, not yet implemented |
| C | [Background pre-warming + autoscaling](docs/superpowers/specs/2026-08-16-phase-c-prewarming-autoscaling-design.md) of the warm-pipeline pool per model | Design written, not yet implemented |
| D | [Token streaming](docs/superpowers/specs/2026-08-16-phase-d-token-streaming-design.md) (`InferenceEngine::complete()` is fully blocking today — no per-token callback exists yet) | Design written, not yet implemented |

**These three designs were written before any of them were built** — each one's own Open Questions/Known Risks section names real, unresolved decisions (notably: Phase B's launcher role is a genuinely new remote-code-execution-shaped surface that needs its own security posture — read that section before implementing; note it was written against the coordinator's then-current no-auth stance, which Security Hardening Phase 1 has since replaced with shared-secret auth, so re-read it in that light rather than taking its security framing at face value). Re-validate against the actual codebase at planning time; don't treat these as settled.

**Phase A is complete and real, not a demo — the milestone is live on `master`.** A client can now `POST /generate {prompt, modelId}` on the coordinator and get a real generated response, produced by an actual `swarm-node-agent` process (single-device or `--remote`-sharded multi-node, both verified live) registered via `servesModel`. Confirmed multiple times independently during whole-branch review, including under real adversarial load: concurrent requests, mid-flight reputation ejection, prompt-injection attempts against the hand-rolled JSON parser, and the real end-to-end test (`coordinator/tests/generate_e2e.ts`, run via `npm run test:e2e`) passing against a live spawned agent and a live GGUF model — not mocked, not skipped.

Known, disclosed limitations of this walking skeleton (named in the README, not silently left out): pipeline composition is entirely operator-configured via CLI flags at agent startup and `servesModel` at registration — nothing dynamic yet (that's Phase B). Single attempt only per `/generate` call — no retry, no fallback to a different node, no request queueing. The agent is single-threaded (one request at a time) with `n_predict` capped at 512; `/health` reflects startup-only readiness (a dead remote RPC device crashes the whole agent process on its next request — an uncatchable upstream `GGML_ABORT`). `POST /nodes/register` now requires a full validated `http://`/`https://` URL for `endpoint` (mirrors `POST /peers/register`'s existing validation) since `/generate` actually fetches it — a bare `host:port` string is rejected. **This phase grew the blast radius of node registration**, and Security Hardening Phase 1 (branch `security-phase-1-auth`) has since narrowed *who* can exploit it, not *what* it does: registering a node now requires the shared `SWARM_AUTH_TOKEN`, so this is a token-holder vector rather than an anyone-on-the-network one. Any token-holder can still register a node claiming any `servesModel`, eject a legitimate competitor via the existing reputation-gaming vector, and receive real user prompts — and, because the coordinator authenticates its outbound `/complete` call, also capture the shared token itself in cleartext. See README's "Known gaming vectors" and Authentication sections. Disclosed, not solved: the fixes (per-node credentials, stable node identity, TLS) are each a whole-service threat-model change — don't bolt one onto an unrelated task.

**Every plan before Phase A** (1–11) built one piece of infrastructure *ready to be wired into* a routing system that didn't exist yet — this was true up through Plan 11 and is why every one of those plans has a "Scope correction" or "What this plan does not do" section naming the gap. Phase A closed it, end to end, for a single manually-configured pipeline. Phases B–D are what make that dynamic, warm-ahead-of-demand, and streaming.

### Security & trust hardening (the initiative alongside request routing)

Design: [`docs/superpowers/specs/2026-08-20-security-hardening-phase-1-auth-design.md`](docs/superpowers/specs/2026-08-20-security-hardening-phase-1-auth-design.md) — read this for Phase 1's full reasoning. Phase 2 has a design ([`docs/superpowers/specs/2026-08-21-security-hardening-phase-2-classifier-ruleset-design.md`](docs/superpowers/specs/2026-08-21-security-hardening-phase-2-classifier-ruleset-design.md)) and plan, with substantial implementation already committed on its own unmerged branch (`security-phase-2-classifier-ruleset`) — not yet reviewed/merged, treat as in-flight, not done. Phase 3 has a design ([`docs/superpowers/specs/2026-08-21-security-hardening-phase-3-sybil-resistant-reputation-design.md`](docs/superpowers/specs/2026-08-21-security-hardening-phase-3-sybil-resistant-reputation-design.md)) and is merged. Phase 4 has a design ([`docs/superpowers/specs/2026-08-21-security-hardening-phase-4-reputation-ranked-selection-design.md`](docs/superpowers/specs/2026-08-21-security-hardening-phase-4-reputation-ranked-selection-design.md)) and is merged — the last phase of this initiative to land.

Four disclosed gaps the dev team flagged, being fixed as one coordinated initiative, in dependency order (each later phase assumes the earlier ones exist):

| Phase | Plan | Status |
|---|------|--------|
| 1 | [Shared-secret authentication](docs/superpowers/plans/2026-08-20-security-hardening-phase-1-auth.md) (`SWARM_AUTH_TOKEN` on every coordinator and node-agent endpoint) | Done |
| 2 | [Real safety-classifier ruleset](docs/superpowers/plans/2026-08-21-security-hardening-phase-2-classifier-ruleset.md) (replacing the zero-rule default `KeywordSafetyClassifier`) | In progress — implemented on unmerged branch `security-phase-2-classifier-ruleset`, not yet whole-branch-reviewed |
| 3 | [Sybil-resistant reputation](docs/superpowers/plans/2026-08-21-security-hardening-phase-3-sybil-resistant-reputation.md) (`ReputationTracker` currently has no defense against churning registrations) | Done |
| 4 | [Reputation-ranked node selection](docs/superpowers/plans/2026-08-21-security-hardening-phase-4-reputation-ranked-selection.md) for `POST /generate` — narrower than Phase B above (that's multi-node pipeline assembly; this only picks the best single already-registered node) | Done |

**Phase 1 is complete and real, live on `master`.** Every coordinator route now requires `Authorization: Bearer <SWARM_AUTH_TOKEN>` except the static dashboard shell and `GET /openapi.json`; `swarm-node-agent` requires the same shared token on both `/health` and `/complete`. Verified via a whole-branch review that included live adversarial probing (auth-bypass attempts via header casing/duplication/whitespace tricks, cross-hop interoperation between a real coordinator and a real spawned node-agent, timing/information-leakage checks) plus one fix round addressing 17 findings, all independently re-verified live before merge — the review's headline catch was a token containing trailing whitespace/a newline silently bricking both services (clean startup log, then universal, undiagnosable 401s forever); both services now reject such a token at startup instead. `swarm-rpc-server` (llama.cpp's raw RPC backend) got no code changes — it has no auth hook in its public API — its exposure is covered by a README-documented tunnel recommendation (SSH/WireGuard) instead.

Known, disclosed limitations (named in README's Authentication and Known gaming vectors sections, not silently left out): one secret shared swarm-wide, not per-node or per-operator credentials — a departed node operator keeps the secret, and the coordinator forwards it in cleartext to any endpoint a registered node claims, so the token's exposure surface is every URL any token-holder ever registers. No encryption-in-transit (traffic stays plain HTTP; TLS was deliberately out of scope — see the design doc's Non-Goals). Cross-operator federation (two coordinators run by different people, each with their own token) silently degrades to zero shared capacity, with only a `console.warn` as a signal — this undercuts a headline property of the project (federation across independent operators) and may deserve its own phase, not just a caveat, when this initiative's later phases are scoped.

**Phase 3 is complete and real, live on `master`.** `NodeRegistry.register()` now derives `nodeId` deterministically from `sha256(lowercased endpoint)` instead of `randomUUID()`, so `Map.set()` naturally overwrites the same registry entry on every re-registration of the same endpoint string — `ReputationTracker` needed zero changes, since it already keys stats by whatever `nodeId` string it's given. This closes the three vectors README previously documented as live-verified: an ejected node clearing its record by re-registering, evading ejection by going quiet past the 30s heartbeat timeout then re-registering, and one endpoint occupying several `localityGroup`s at once. Whole-branch review (live adversarial probing: concurrency, prototype-pollution-style `localityGroup` values, 22 malformed/edge-case endpoint strings, cross-endpoint filtering consistency across `GET /nodes`/`/capacity`/`/nodes/locality`/`/catalog`/`/generate`) found the code itself correct and the diff minimal, but caught one blocking documentation issue before merge: the identity guarantee is per **endpoint string**, not per **physical node** — `stableNodeId()` only lowercases the endpoint, it does not canonicalize it, so a single listening socket still gets a fresh, clean identity for free under an alias (`127.0.0.1` vs `localhost` vs `[::1]` vs a trailing-dot FQDN vs any other DNS name pointed at it), no new port or infrastructure required. This is materially cheaper than the "several ports on one machine" framing an earlier draft used, and is now disclosed accurately in README's "Known gaming vectors" and "Locality grouping" paragraphs. Also newly disclosed there: this phase's own overwrite-on-register mechanism lets any token-holder who knows a node's endpoint silently strip its `servesModel`/`deviceTier`/`localityGroup` claim with one call and zero reputation trace (a denial/griefing primitive, not a token-capture one — verified live it cannot redirect traffic, since the coordinator's `new URL().href` parsing already normalizes the host before hashing); and that an ejected node can also be fully rehabilitated in place, no re-registration needed, via 6 `POST /nodes/:nodeId/reputation/agree` calls, since the reputation-mutating routes deliberately check the unfiltered node list (pre-existing `master` behavior, not introduced by this phase). None of these residual gaps are fixed here — closing endpoint-aliasing or the overwrite vector needs the same proof-of-endpoint-possession mechanism (node-supplied public-key identity) this phase's design doc already rejected as out of scope; see README for full detail.

**Phase 4 is complete and real, live on `master`.** `POST /generate` now ranks active/trusted/`servesModel`-matching candidates by a new `ReputationTracker.score()` method — a Laplace-smoothed agreement ratio, `(agreements + 1) / (agreements + disagreements + 2)`, so an untested node scores a neutral `0.5` and more evidence at the same ratio scores closer to the extreme — instead of picking the first one found (`Array.prototype.find` in `Map` insertion order). Exact ties (most commonly several untested nodes) are broken uniformly at random via an injected `random` function threaded through `createServer(...)`, mirroring `NodeRegistry`'s existing injectable-`clock` pattern for deterministic tests. `NodeRegistry` and `ReputationTracker`'s existing methods needed zero changes. Whole-branch review (live adversarial probing: ~450 real `/generate` calls against a real running coordinator, covering ranking correctness, tie-break engagement and freshness-per-request, ejection-regression, 20+-node and pathological-ratio edge cases, and concurrency) found the implementation itself correct and minimal, and caught two things before merge: a stale `GET /openapi.json` description still claiming "first-match" selection (the project's canonical developer-facing API contract — now corrected), and an undisclosed consequence of the ranking mechanism itself — since the reputation-recording endpoints already let any token-holder record arbitrary agree/disagree events for any node, Phase 4 turns that pre-existing write primitive into a direct, cheap, and (unlike ejection) **untraceable-on-the-victim** traffic-steering vector: self-issuing `A + 1` agree calls against your own node beats a competitor with `A` real agreements. Two related consequences of the pre-existing all-time/no-decay scoring were named alongside it: a degraded-but-still-"trusted" veteran node can permanently monopolize routing over a pristine one, and the already-disclosed 6-call ejection-rehab path now immediately outranks untested peers too — see README's "Known gaming vectors" for the full live-verified detail. No code fix was needed for these; they're disclosed, not solved, matching this project's established pattern, since the real fix (proof-of-endpoint-possession identity) was already rejected as out of scope back in Phase 3's design doc.

This closes the four-phase Security & Trust Hardening initiative's design roadmap — Phases 1, 3, and 4 are merged; Phase 2 (real safety-classifier ruleset) remains implemented-but-unmerged on its own branch and is the one piece still needing a whole-branch review before this initiative is fully landed.
