# swarm-llm

**A federated, open-source network for running open-weight LLMs on compute
people already own** — phones, laptops, desktops — instead of a single
company's data center. No central authority (Mastodon/Matrix-style
federation: anyone can run a coordinator instance and peer with others). No
cryptocurrency, token, or mining layer of any kind — this project exists to
give people free access to bigger and better open models by pooling idle
hardware, not to pay contributors in a coin. Full vision:
[`docs/superpowers/specs/2026-08-14-distributed-llm-inference-design.md`](docs/superpowers/specs/2026-08-14-distributed-llm-inference-design.md).

## Why this exists

Running a large open-weight model well requires more RAM/VRAM than almost
any single consumer device has. The usual answers are "pay a cloud
provider" or "run a small, worse model locally." This project's bet is a
third option: split a large model across many ordinary machines'
spare capacity — the same idea that makes a datacenter's fast interconnect
useful, applied to phones and laptops on a home network or the open
internet — and grow the set of models a swarm can serve as more people
contribute capacity, entirely for free. Every model stays open-weight;
nobody pays to participate, and nobody gets paid to contribute hardware.
Safety and consent are treated as first-class from the start (see the
safety-classifier gate and reputation/ejection sections below), not bolted
on later.

**`swarm-cli` is the proof that the hard part works today.** It's a real
`llama.cpp`-backed inference engine (`swarm::InferenceEngine`) that can
already split a single model's layers across a local device and one or more
networked peers via a minimal RPC mechanism, place Mixture-of-Experts
tensors on chosen devices, and verify several speculative tokens per
round-trip to cut latency. That's the computational core the whole
federated-swarm idea depends on — everything else in this repo (the
coordinator service, safety gate, reputation ledger, locality grouping, web
dashboard, developer API) exists to eventually route real requests to a
swarm of these engines instead of one.

**Current status:** 11 of the project's implementation plans are complete,
and Phase A of the request-routing initiative that follows them is done too
— see [`CLAUDE.md`](CLAUDE.md)'s Plan Roadmap for exactly what's built
versus what's still ahead. In short: the compute engine, a federated
coordinator service, a browser client, and a working end-to-end
request-routing path (`POST /generate`, routing a prompt through the safety
gate to a real `swarm-node-agent` and back) all work and are tested. What's
still missing is dynamic node selection instead of manual registration
(Phase B), background pre-warming/autoscaling of warm pipelines (Phase C),
and token streaming (Phase D). That's the natural next place to contribute.

## Get involved

This is early, real infrastructure — not a finished product — and it's
built in the open specifically so people can pick up a piece of it. Useful
ways to help right now:

- **Dynamic pipeline assembly, pre-warming, and streaming** — Phases B, C,
  and D of the request-routing initiative (see above); manual, single-node,
  non-streaming routing (Phase A) is done, but nothing dynamic,
  demand-driven, or streamed exists yet. Every existing piece (capacity
  tracking, safety gate, reputation, locality) is groundwork waiting for
  this.
- **Client apps** — this repo currently ships a browser dashboard only
  (native mobile/desktop apps were deliberately deferred — see
  [`CLAUDE.md`](CLAUDE.md)'s Plan 10 note for why).
- **Testing on real hardware** — everything so far has been built and
  tested on a single Windows dev machine; multi-machine, multi-platform,
  real-network testing would surface things a single-box test suite can't.
- **Model coverage and sharding strategy** — MoE layer placement and
  speculative decoding exist; there's a lot of room to improve throughput
  and model support.

Start with [`CLAUDE.md`](CLAUDE.md) for repo layout, conventions, and the
development workflow this project follows for every change (plan → review →
merge, with an emphasis on live-tested behavior over code-review-only
sign-off). Open an issue or a PR — there's no formal process yet beyond
that.

## Prerequisites

- **Windows:** [MSYS2](https://www.msys2.org/) with the MinGW-w64 UCRT64
  toolchain (`mingw-w64-ucrt-x86_64-gcc`, `mingw-w64-ucrt-x86_64-cmake`,
  `mingw-w64-ucrt-x86_64-ninja`).
- **Linux/macOS:** an equivalent C++17 toolchain (GCC or Clang, CMake, and
  Ninja).

## Clone

```bash
git clone --recurse-submodules https://github.com/linga009/DDC.git
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init
```

## Download the test model

```bash
./scripts/download_test_model.sh
./scripts/download_moe_test_model.sh
```

This downloads a small TinyLlama GGUF model into `models/` for use by the
test suite and the `swarm-cli` example below. The second script fetches a
~90MB MoE (mixture-of-experts) model used by the layer-placement tests.

Two more small models are available for testing against real, current
open-weight model families rather than only the TinyLlama fixture above:

```bash
./scripts/download_qwen_test_model.sh       # Qwen2.5 0.5B Instruct, ~490MB
./scripts/download_deepseek_test_model.sh   # DeepSeek-R1-Distill-Qwen 1.5B, ~1.1GB
```

Both are already wired into the coordinator's default model catalog
(`qwen2.5-0.5b`, `deepseek-r1-distill-qwen-1.5b` — see the Coordinator
service section below) and have been verified end-to-end through
`swarm-node-agent` and `POST /generate`. The DeepSeek download script uses
`curl -C -` (resume) with 8 retries — this specific file has been observed
to have its connection drop mid-transfer without curl reporting an error,
leaving a truncated file that still parses as a valid GGUF header but fails
to load at runtime; the checksum check catches this if it happens again.

## Build

```bash
cmake -G Ninja -S . -B build
cmake --build build
```

## Run the tests

```bash
./build/core/tests/inference_engine_test.exe
```

or, from the build directory:

```bash
cd build && ctest
```

## Run swarm-cli

```bash
./build/core/swarm-cli.exe --model models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf "The capital of France is"
```

Example output:

```
The capital of France is Paris.
```

## Networking and RPC sharding

This repo includes a first, minimal step toward multi-node inference, built
on llama.cpp's RPC backend:

- **`swarm-rpc-server`** — a small executable (`core/src/rpc_server_main.cpp`)
  that exposes the local CPU device so another process can offload
  computation to it. Run it with `--port N`. It binds to `127.0.0.1` only —
  there is currently no option to bind another interface, so it is reachable
  only from the same machine.
- **`swarm::InferenceEngine`** has a second constructor overload,
  `InferenceEngine(model_path, remote_endpoints)`, that combines the local
  CPU device with one or more remote devices reached via `swarm-rpc-server`
  instances, so model layers can be split across the local machine and
  remote hosts.

> [!WARNING]
> The underlying llama.cpp RPC backend is, in upstream's own words, "in a
> proof-of-concept development stage. As such, the functionality is fragile
> and insecure." **Never run `swarm-rpc-server` on an open or untrusted
> network.** It has no authentication or encryption. It is suitable for
> trusted LAN or same-host use only, and currently binds to `127.0.0.1` for
> exactly this reason. If you need it reachable across more than one
> trusted machine, put it behind an SSH tunnel (`ssh -L`) or WireGuard
> rather than exposing the port directly — this gets you both
> authentication (the tunnel's own key-based auth) and encryption for
> free, without any code change here.

## Node agent

`swarm-node-agent` (`core/src/node_agent_main.cpp`) is a long-lived process
that loads a model once at startup and serves it over HTTP, wrapping
`swarm::InferenceEngine`'s existing, unchanged public API:

```bash
./build/core/swarm-node-agent.exe --model models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf --port 8081
```

CLI flags:

- `--model <path.gguf>` (required) — path to the GGUF model file.
- `--port N` (required) — port to bind on `127.0.0.1`.
- `--remote host:port` (repeatable, optional) — one or more `swarm-rpc-server`
  endpoints to shard the model across, same as `InferenceEngine`'s
  remote-device constructor.
- `--layer-placement N:endpoint` (repeatable, optional) — pin a specific
  layer's MoE expert tensors to a device endpoint (`local` or one of the
  `--remote` endpoints), same as `InferenceEngine`'s layer-placement
  constructor.

> [!WARNING]
> `swarm-node-agent`'s HTTP endpoints (`/health`, `/complete`) require the
> shared `SWARM_AUTH_TOKEN` (see the Coordinator service section's
> Authentication subsection below) but still have no encryption of their
> own — traffic is plain HTTP. It binds to `127.0.0.1` by default; there is
> currently no `--host` flag to bind another interface. If you need it
> reachable across more than one trusted machine, put it behind an SSH
> tunnel or WireGuard rather than exposing the port directly, matching
> `swarm-rpc-server`'s recommendation above.

It exposes two HTTP endpoints:

- `GET /health` — returns `200 {"status":"ready"}` once the model has
  finished loading and the server is accepting connections. This reflects
  only that startup finished — it is **not** a live engine-health check.
  If a remote RPC device this agent depends on (via `--remote`) disappears
  mid-session, the underlying llama.cpp RPC transport aborts the whole
  process on the next request (an upstream `GGML_ABORT`, not a catchable
  C++ exception, so `/complete` cannot turn it into a clean error
  response). `/health` will keep reporting `ready` right up until that
  abort happens.
- `POST /complete` — body `{"prompt": "...", "n_predict": 64}`
  (`n_predict` optional, defaults to 64) returns `200 {"text": "..."}` with
  the generated completion. Returns `400` if `prompt` is missing or its
  value is not a JSON string (a number, `null`, `true`/`false`, a nested
  object, or an array are all rejected, not silently coerced). `n_predict`
  is capped at `512` — a value above that returns `400
  {"error":"n_predict must not exceed 512"}` rather than running (a large
  `n_predict` against `InferenceEngine`'s fixed context size can otherwise
  tie up this single-threaded server for minutes, blocking even `/health`,
  and then fail outright once the context is exhausted, discarding every
  token generated). Note the asymmetry: a non-numeric or otherwise
  malformed `n_predict` is **not** rejected — it silently falls back to the
  default (64); only a valid, in-range-parsed-but-out-of-bounds integer
  triggers the `400`. Even within the 512 cap, a single request can still
  take significant time depending on model size and node hardware — this
  cap bounds the worst case, it does not guarantee a fast response. Note
  that this cap bounds *generation* length only, not prompt processing
  time: live testing found that a request with a very long prompt (not a
  long `n_predict`) can still tie up this single-threaded agent for over a
  minute before failing, since there is currently no bound on prompt
  length or prompt-processing time at either the coordinator or the agent
  level.

JSON string values (like `prompt`) are decoded assuming standard
`JSON.stringify`-style escaping. A client using a JSON library that escapes
non-ASCII characters as `\uXXXX` for codepoints at or above `0x80` (e.g.
Python's `json.dumps` with its default `ensure_ascii=True`) will have those
characters corrupted, since only `\u00XX` (codepoints below `0x80`) is
decoded here. Requests built with `JSON.stringify` (as this project's
coordinator does) are unaffected for normal Unicode text. One narrow
exception: a lone/unpaired UTF-16 surrogate in a prompt (a rare, malformed
input, not a normal usage concern) is itself emitted by `JSON.stringify` as
a literal `\udXXX` escape sequence, which this agent's decoder does not
turn back into a real character — live-verified, it round-trips as the
6-character escape text, not a character. So the "coordinator is
unaffected" claim above does not fully cover this specific edge case.

Like `swarm-rpc-server`, this is a minimal building block: it serves one
request at a time, with no concurrency, request queueing, or clean-shutdown
path — it runs until killed (see the Authentication warning above for its
`SWARM_AUTH_TOKEN` requirement). The coordinator's
`POST /generate` (see the Coordinator service section below) is now a real
caller of this agent's `POST /complete` endpoint — the first thing in this
repo to actually route a request to `InferenceEngine` over HTTP end to end.

## Coordinator service

`coordinator/` is a small HTTP service that tracks which nodes are alive and
uses their count to gate which models in the catalog are announced as
available. It requires Node.js 22.6+ (native TypeScript support — no build
step, and it has zero npm dependencies).

Run its tests:

```bash
cd coordinator && npm test
```

Start it (see the Authentication subsection immediately below —
`SWARM_AUTH_TOKEN` is required, the coordinator will not start without it):

```bash
SWARM_AUTH_TOKEN=<your-secret> PORT=8080 node src/main.ts
```

### Authentication

Every coordinator endpoint except the static dashboard shell (`GET /`,
`/app.js`, `/style.css`) and the OpenAPI document (`GET /openapi.json`)
requires a shared secret, set as the `SWARM_AUTH_TOKEN` environment
variable, sent as `Authorization: Bearer <token>`. The coordinator refuses
to start if `SWARM_AUTH_TOKEN` is unset:

```bash
SWARM_AUTH_TOKEN=<your-secret> PORT=8080 node src/main.ts
```

`swarm-node-agent` requires the *same* token (one shared secret across the
whole swarm, not per-node) on both `/health` and `/complete`:

```bash
SWARM_AUTH_TOKEN=<your-secret> ./build/core/swarm-node-agent.exe --model models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf --port 8081
```

Both the coordinator and `swarm-node-agent` **refuse to start if
`SWARM_AUTH_TOKEN` contains a newline or leading/trailing whitespace**,
rather than accepting it. This is deliberate and worth knowing about,
because `SWARM_AUTH_TOKEN=$(cat secret.txt)` on a file with a trailing
newline, a `.env` line with a stray trailing space, and
`docker --env-file` all produce exactly that. Such a token can never
authenticate anyone — every HTTP parser strips the whitespace around a
received header value, so the received token can never be byte-equal to a
configured one that still carries it — and the failure mode without this
check is brutal: a completely healthy-looking startup log followed by a
`401` on every single request, including ones sending the byte-exact
token. The token is *not* silently trimmed: if your secret isn't what you
think it is, you should be told, not have it quietly rewritten.

This closes "anyone can register a fake node, submit inference requests,
or read swarm state" for anyone who doesn't have the token — it does
**not** add encryption-in-transit (traffic is still plain HTTP) and it
does **not** stop a legitimate token-holder from misbehaving (registering
many fake nodes, claiming a `servesModel` they don't actually serve,
etc. — see the gaming-vector notes throughout this doc, most of which are
about token-holder behavior, not outsider access). For encryption, or for
running nodes across anything wider than a single trusted LAN, put an SSH
tunnel or WireGuard in front — see `swarm-rpc-server`'s note above, which
applies equally here.

**The one shared secret is forwarded to whatever endpoint a registered
node claims to be.** `POST /generate` sends `Authorization: Bearer
<the-shared-token>` to the node's `endpoint` URL, and `GET /catalog`
sends it to every registered peer coordinator — so the token's exposure
surface is *every URL any token-holder ever registers*, in cleartext (no
TLS, by design — see the Non-Goals in the security design doc). Verified
live: an attacker-controlled listener registered as a node with a matching
`servesModel` received both the real shared token and a real user prompt
on its `/complete`. This is not an outsider bypass — you already need the
token to register anything — but it means one dishonest or compromised
token-holder can harvest the secret without ever attacking the
coordinator, and any node operator who is later removed from the swarm
already has it. A single swarm-wide secret is inherent to this phase's
design; per-node tokens or mTLS are named as deferred scope in the design
doc, not solved here.

Endpoints:

- `POST /nodes/register` — register a node, returns a `nodeId`. `endpoint`
  must be a full, valid `http://` or `https://` URL (e.g.
  `http://127.0.0.1:8081`) — a bare `host:port` string like `127.0.0.1:8081`
  is rejected with `400`, and a trailing slash is stripped before storing.
  This mirrors `POST /peers/register`'s existing validation and matters
  because `POST /generate` (see below) actually `fetch()`es this URL; an
  unnormalized or malformed endpoint used to register successfully and only
  fail later, confusingly, at `/generate` time. Accepts an
  optional `localityGroup` string field (must be non-empty when provided) —
  see the locality-grouping note below. Also accepts an optional
  `servesModel` string field (must be a known catalog model id when
  provided) declaring which model this node can serve inference requests
  for. Like `localityGroup`, this is **self-reported and unverified** — the
  coordinator does not check that a node actually has the declared model
  loaded and ready; `POST /generate` (see below) trusts it at routing time.
  Combined with this, anyone who has the shared `SWARM_AUTH_TOKEN` — not
  the general public, but any single compromised or dishonest swarm
  member — can register an endpoint claiming to serve a given model and
  start receiving real `/generate` traffic for it — see the known gaming
  vectors below for the sharper version of this involving reputation
  ejection.
- `POST /nodes/:nodeId/heartbeat` — refresh a node's liveness
- `GET /nodes` — list currently active nodes
- `GET /nodes/locality` — active nodes bucketed by their self-reported
  `localityGroup`: `{ [group: string]: NodeInfo[] }`. A node registered
  without a `localityGroup` is bucketed under `"ungrouped"`. Uses the same
  reputation filtering as `GET /nodes` — an ejected node does not appear in
  any group.
- `GET /catalog` — list models with `available` gated on active node count
- `GET /capacity` — report this instance's active node count, for peers to fetch
- `POST /peers/register` — register a federated peer instance, returns a `peerId`
- `POST /peers/:peerId/heartbeat` — refresh a peer's liveness
- `GET /peers` — list currently active peers
- `DELETE /peers/:peerId` — deregister a peer
- `POST /classify` — pluggable safety gate: submit `{ "prompt": string }`,
  get back `{ safe: boolean, categories: string[] }`. **The shipped
  `KeywordSafetyClassifier` ships with zero rules by default and performs no
  real content moderation — it exists only to prove the gate's plumbing
  (fail-closed error handling, request/response shape, timeout behavior). A
  real classifier must be supplied by implementing the `SafetyClassifier`
  interface (`coordinator/src/safety_classifier.ts`).** `/classify` is
  also callable directly and independently of `/generate` below — it is
  not exclusively an internal implementation detail of routing.
- `POST /generate` — submit `{ "prompt": string, "modelId": string,
  "n_predict"?: number }`, get back `{ "text": string }`. Classifies the
  prompt first (fails closed on an unsafe prompt or a classifier error,
  same posture as `/classify`), finds an active node whose self-reported
  `servesModel` matches `modelId`, forwards the request to that node's
  `swarm-node-agent` `POST /complete` endpoint, and returns its generated
  text. Returns `400` if the request is invalid or the prompt was
  classified unsafe, `503` if no active node currently serves the
  requested model, `502` if the selected node is unreachable or returns a
  malformed response. `n_predict` defaults to 64 and is capped at 512,
  mirroring `swarm-node-agent`'s own cap. Single attempt only — no retry,
  no fallback to a different node on failure, no streaming (the response
  arrives complete or not at all). Combined with Security Hardening Phase
  4's random tie-break among equally-scored candidates (see below): if one
  of several tied nodes is dead, identical requests now succeed or 502
  *at random* from call to call, rather than the deterministic 100% 502 a
  dead first-registered node produced before that phase — still correct
  given the no-retry limitation, but worth knowing when diagnosing an
  intermittently-failing `/generate`. See the paragraph below for what this
  endpoint does and doesn't do yet.
- `POST /nodes/:nodeId/reputation/agree` / `POST /nodes/:nodeId/reputation/disagree`
  — record that a node's output agreed or disagreed with a redundant
  spot-check computation (204, or 404 if `nodeId` is unknown)
- `GET /nodes/:nodeId/reputation` — report a node's reputation stats:
  `{ agreements: number, disagreements: number, trusted: boolean }`
- `GET /` — serves the web dashboard (see Web client section below)
- `GET /app.js` — serves the web dashboard's client-side JavaScript (see Web
  client section below)
- `GET /style.css` — serves the web dashboard's stylesheet (see Web client
  section below)
- `GET /openapi.json` — serves the hand-written OpenAPI 3.0 document
  describing the JSON API routes above (see Developer API section below)

**`POST /generate` is the first endpoint in this repo that produces a real
generated response.** Every other endpoint above it was groundwork —
registry, capacity, safety gate, reputation, locality — built ahead of a
request-routing system that didn't exist yet; this is that system's first
piece. It requires at least one `swarm-node-agent` process (see the Node
agent section above) to be running and registered via `POST
/nodes/register` with a `servesModel` value matching the requested
`modelId` — without one, every call to `/generate` returns `503`. That node
must also keep sending `POST /nodes/:nodeId/heartbeat` periodically (the
same 30-second liveness timeout every other endpoint relies on) — once it
ages out of the registry from a missed heartbeat, `/generate` stops finding
it and returns `503` again, exactly as if it had never registered. This is
still only Phase A of the request-routing initiative: node selection is
reputation-ranked as of Security Hardening Phase 4 (see below) rather than
a raw first-match scan, but is still not locality-aware or a general load
balancer, there is no background pre-warming of pipelines ahead of demand,
and there is no token streaming (a `/generate` call blocks until the full
response is ready or the request fails). See
[`docs/superpowers/specs/2026-08-16-request-routing-design.md`](docs/superpowers/specs/2026-08-16-request-routing-design.md)
for Phases B (dynamic, coordinator-driven pipeline assembly), C
(pre-warming and demand-based autoscaling), and D (token streaming) — none
of which are implemented yet.

A node with zero recorded checks is trusted by default. Ejection (excluding
the node from `GET /nodes`, `GET /capacity`, and `/catalog`'s active-node
count) requires both a minimum sample size and a disagreement rate at or
above threshold — the defaults are `minSamples=5` and
`disagreementThreshold=0.5`, and neither is currently runtime-configurable
(both are `ReputationTracker` constructor parameters, hardcoded at their
defaults in `main.ts`). This means a node doesn't eject on a single sample.
This is not a defense against a malicious caller — the minSamples/threshold
gate exists to absorb noisy or unlucky spot-check results, not adversarial
ones; see the shared-token caveat below (any token-holder, not just an
outsider, can still call the reputation-recording endpoints maliciously).
**The coordinator does not implement
the actual redundant-computation spot-check mechanism** (running the same
request on two independently-chosen nodes and comparing outputs) —
`POST /generate` (Phase A, see below) only selects and calls a single node
per request, with no redundant dispatch to a second node for comparison, so
this specific dual-node mechanism still doesn't exist. It only builds the
reputation ledger and ejection policy, ready to be wired into a future
dual-node dispatch path. Reputation endpoints themselves stay operable on an
already-ejected node (so future spot-check results can still be recorded
for it) — only capacity-facing views exclude it.

**Security Hardening Phase 4 adds reputation-ranked node selection to
`POST /generate`.** Previously it picked the first active, trusted node
matching the requested `servesModel` (`Array.prototype.find` in `Map`
insertion order); it now scores every such candidate with
`ReputationTracker.score()` — a Laplace-smoothed agreement ratio,
`(agreements + 1) / (agreements + disagreements + 2)` — and picks the
highest-scoring one, breaking exact ties (most commonly: several untested
nodes, which all score a neutral `0.5`) by choosing uniformly at random
among them rather than always favoring whichever node happened to register
first. This changes *ranking* only, not *eligibility* — a node still has
to pass `isTrusted()`'s existing minSamples/disagreementThreshold gate to
be a candidate at all. In practice this ranks mostly-untested nodes today:
nothing in this codebase automatically calls the reputation-recording
endpoints from `/generate`'s own outcomes, so real ranking signal only
exists where an operator or external tool has manually recorded it — a
future automatic-feedback phase is real potential follow-on work, not
implemented here. The score is also only as durable as the `nodeId` it's
attached to — see the endpoint-aliasing caveat in "Known gaming vectors"
below; an operator can mint a fresh, neutral-scoring identity for the same
physical node by re-registering under an alias. This is not a general load
balancer: there is no in-flight-request tracking or capacity weighting,
only a random tie-break among exactly-equal scores.

**This ranking mechanism is itself gameable, and cheaply.** The
reputation-recording endpoints already let any token-holder record
arbitrary agree/disagree events for any node (see above); Phase 4 is what
turns that pre-existing write primitive into a direct traffic-steering
one. Verified live: an attacker registers a node and self-issues
`POST /nodes/:nodeId/reputation/agree` calls against their own `nodeId` —
beating a competitor with `A` real agreements costs exactly `A + 1`
self-issued calls (Laplace scoring is monotonic in raw agreement count at
a fixed ratio), takes well under a second locally, and — unlike ejecting
the competitor via 5 disagreements — leaves **no trace on the victim at
all**: it stays listed in `GET /nodes`, stays `trusted: true`, keeps its
own disagreement count unchanged. Two related consequences of the same
all-time, no-decay scoring the "Known gaming vectors" note above already
flags as an ejection weakness: a node with a genuinely bad but
merely-still-trusted history (e.g. `200` agreements / `100` disagreements
— a 33% disagreement rate, under the 50% ejection threshold, but a Laplace
score of `201/303 ≈ 0.66`) can **permanently monopolize** routing over a
pristine untested node, since raw evidence volume outweighs a slightly
worse ratio; and the already-disclosed 6-call ejection-rehab path doesn't
just rejoin the pool post-Phase-4, it immediately **outranks every
untested competitor** (a freshly-rehabbed `6/5` node scores `7/13 ≈ 0.54`,
above the `0.5` neutral baseline). None of this requires an outsider — it
is the same shared-token threat model as everywhere else in this section —
but Phase 4 is what makes reputation data worth attacking rather than
merely worth ignoring.

**Caveat:** `POST /peers/register` now requires `SWARM_AUTH_TOKEN` (see
Authentication above), and by default the server binds only
to `127.0.0.1`; setting `HOST` to bind wider (e.g. `0.0.0.0`) should only be
done on trusted networks. Federation compounds this: once a peer is
registered, this instance makes an outbound HTTP request to it on every
`GET /catalog` call, so anyone who has the token can add outbound request
targets — this is a smaller set than "anyone on the network" but is not
"only operators who should be adding peers," since there's still only the
one shared token, not per-operator credentials.
**Cross-operator federation is effectively broken by the shared-token
model:** because the outbound `/capacity` poll authenticates with *this*
instance's `SWARM_AUTH_TOKEN`, a peer coordinator running a *different*
operator's token rejects that poll with a `401` and therefore contributes
`0` to federated capacity — verified live. Nothing surfaces this except a
`console.warn` on the polling side: `GET /catalog` still returns `200`,
just with a silently smaller active-node count, which can leave a model
looking unavailable when the federation really does have the capacity for
it. Federating usefully today means every peer shares one token (a single
trust domain), which is a real limitation for a project whose whole point
is federation across independent operators. Per-operator credentials are
deferred, not solved.
The reputation-recording endpoints now require the same token — currently
any token-holder can still record arbitrary agreement/disagreement events
for any node, since the token is shared swarm-wide rather than scoped per
node or per operator.
Reputation state is in-memory only and does not persist across restarts.

**Known gaming vectors:** reputation is keyed by `nodeId`. **Fixed in
Security Hardening Phase 3:** `NodeRegistry.register()` used to mint a
fresh `randomUUID()` on every call with no endpoint dedupe, so an ejected
node could clear its record with one more `POST /nodes/register` call —
verified live: 5 disagreements ejected a node, one re-register call
restored it with a clean slate, and (once `POST /generate` existed) that
clean-slate node could go on to capture real user traffic for a model and
the swarm's shared token in cleartext (registering an endpoint you control
is enough to capture `SWARM_AUTH_TOKEN`, since the coordinator
authenticates its outbound `/complete` call with it). `nodeId` is now a
deterministic `sha256` hash of the (lowercased) endpoint rather than a
random value, so `Map.set()` naturally overwrites the same entry on every
re-registration of the *same endpoint string*, no matter how much time has
passed or whether the previous entry already aged out of the registry — a
node cannot shed reputation history by re-registering with the identical
endpoint string it already used, and cannot escape it by going quiet past
the 30-second heartbeat timeout and coming back either. Verified live:
eject a node with 5 disagreements, re-register the same endpoint,
`GET /nodes` still excludes it and `GET /nodes/:nodeId/reputation` still
reports the same `nodeId` with its disagreement count intact.
**Not fixed by this:** identity is stable per *endpoint string*, not per
underlying node — `stableNodeId()` only lowercases the string, it does not
canonicalize it, so a single listening socket answers to unlimited alias
strings for free, no new port or infrastructure required. Verified live: a
node ejected while registered as `http://127.0.0.1:PORT` re-registers as
`http://localhost:PORT` (same running server, same socket) and comes back
with a completely different `nodeId` and a clean `0/0, trusted: true`
reputation record — `/generate` immediately routes to it again. The same
works with `http://[::1]:PORT`, a trailing-dot FQDN vs. the bare form, or
any other DNS name pointed at the same machine. An attacker who holds
`SWARM_AUTH_TOKEN` can separately mint unlimited genuinely-distinct
identities by registering different endpoints (e.g. several ports on one
machine) too — Phase 3 makes a given endpoint *string* stable and
non-resettable, it does not limit how many strings, aliased or distinct,
one attacker can register in the first place. Relatedly, an ejected node
does not even need to re-register to come back: the reputation-mutating
routes deliberately check the *unfiltered* node list rather than the
reputation-filtered one (so an already-ejected node stays reachable for
legitimate agree/disagree corrections), which also means any token-holder
can rehabilitate an ejected node in place with 6
`POST /nodes/:nodeId/reputation/agree` calls, no re-registration involved;
verified live. The overwrite-on-register mechanism that makes identity
durable for a *given* endpoint string also cuts the other way: any
token-holder who knows a node's exact `endpoint` (trivially readable via
`GET /nodes`) can silently overwrite that node's `deviceTier`/
`localityGroup`/`servesModel` claim by re-registering the same endpoint —
verified live: registering `http://127.0.0.1:1` again with no `servesModel`
field instantly stripped a live, fully-trusted node's `servesModel` claim
from its registry entry, with zero reputation calls made and no trace
visible via `GET /nodes/:nodeId/reputation` (still `0/0`, `trusted: true`)
— unclaiming a competitor from `/generate` routing for its real model in
one HTTP call, cheaper and stealthier than the five-disagreement ejection
vector above. This is a new consequence of Phase 3's own fix, not present
before it: pre-Phase-3, re-registering someone else's endpoint minted a
harmless duplicate entry under a different `nodeId` rather than overwriting
the original. It does not let the attacker redirect traffic to themselves
— the coordinator's `new URL().href` parsing already normalizes the *host*
to lowercase before `stableNodeId()` ever sees it, so this overwrite can
only clobber the record's other fields, never repoint where `/generate`
actually sends the request — so it is a targeted denial/griefing primitive,
not a token-capture one. No fix is scoped for any of this; closing the
endpoint-aliasing and overwrite gaps both need the same
proof-of-endpoint-possession mechanism (e.g. node-supplied public-key
identity) already rejected as out of scope for this phase. Separately, the
disagreement ratio is still all-time with no decay or windowing, so an established node
with a long good history (e.g. 200 agreements) still needs 200
*consecutive* disagreements to be ejected — the inverse of catching a node
that goes bad (compromised, degraded hardware) after building trust, and
effectively un-ejectable at any realistic spot-check sampling rate. Fixing
this requires a sliding window or EWMA scoring function instead of a
lifetime ratio, and remains unscoped and undesigned (see the Security
Hardening Phase roadmap in `CLAUDE.md`).

**Locality grouping is self-reported and unverified:** `localityGroup` is an
arbitrary string a node supplies at registration time — the coordinator
performs no check that it reflects real physical or network proximity. A
node can claim membership in any group, including one it has no actual
adjacency to, with no cost or detection beyond holding the shared
`SWARM_AUTH_TOKEN` (the same shared-token caveat above applies here too —
registration now requires the token, but any token-holder can still claim
any group for free). **Security Hardening Phase 3 fixed the amplified
version of this:** before that phase, `NodeRegistry.register()` minted a
fresh `randomUUID()` on every call with no endpoint dedupe, so one physical
device could register itself repeatedly under different `localityGroup`
values and appear in multiple groups simultaneously — verified live at the
time: the same endpoint registered under `"kitchen-mesh"`, `"office-mesh"`,
and `"garage-mesh"` produced 3 distinct nodeIds, all live simultaneously in
`GET /nodes/locality`. `nodeId` is now a deterministic hash of the endpoint
(see the reputation gaming-vectors note above), so re-registering the exact
same endpoint string under a new group now overwrites the previous
registration instead of adding to it — a node can still claim any single
group it likes under a given endpoint string, but can no longer occupy
several groups under that same string at once. As with the reputation fix
above, this is a per-endpoint-string guarantee, not a per-device one: the
same physical node can still occupy several groups simultaneously by
registering under aliases of itself (`127.0.0.1` vs `localhost` vs `[::1]`
vs any other DNS name pointed at it), one group per alias — that gap is
not closed by this phase. This matters because `GET /nodes/locality`
exists as groundwork for a future pipeline assembler that will likely
prefer larger or majority locality clusters when selecting nodes; the fix
raises the cost of inflating a group's apparent size (from "one call per
extra entry" to "one call per extra alias"), it does not close it. The
base truthfulness gap remains open: a single false claim about which one
group a node belongs to is still free and undetected.
Separately, a node can also register with `localityGroup: "ungrouped"`
verbatim, which is indistinguishable from a node that never set the field
at all. `GET /nodes/locality` exists purely as a stable, queryable
interface for grouping; no pipeline-assembly or locality-aware
request-routing system in this repo yet consumes it — `POST /generate`
(Phase A, see below) ranks candidates by reputation score (Security
Hardening Phase 4, see above) but has no locality-awareness at all, and
this repo still has no cross-instance (federated) or multi-node
pipeline-aware request routing of any kind. No
client-side mesh-discovery mechanism (WiFi Direct, Multipeer Connectivity,
LAN broadcast) yet exists to produce real, verifiable locality identifiers,
either.
Both are expected to be built against this interface later.

## Developer API

For programmatic access to the coordinator, two things exist:

- **`GET /openapi.json`** — a hand-written OpenAPI 3.0 document describing
  every JSON API endpoint listed above (the static dashboard routes and
  `/openapi.json` itself are excluded). Point standard OpenAPI tooling
  (Swagger UI, client codegen, Postman, etc.) at
  `http://<host>:<port>/openapi.json` on a running instance to explore the
  API or generate a client for it. It is hand-written, not generated from
  the route code, so it can drift from actual behavior if a route's
  request/response shape changes without the doc being updated — a test in
  `coordinator/tests/server.test.ts` only catches a documented path
  disappearing, not a shape drifting. The document declares a `bearerAuth`
  security scheme and applies it to every operation, so a **generated
  client must be configured with the shared `SWARM_AUTH_TOKEN`** or every
  call it makes will `401` (each operation documents that `401`). The doc
  itself stays reachable without a token, deliberately — that is how a
  developer discovers a token is required in the first place.
- **`coordinator/src/client.ts`** — a minimal `SwarmClient` class, one typed
  method per JSON API endpoint listed above (the static dashboard routes
  and `/openapi.json` itself are excluded), that talks to those routes
  directly (independent of the OpenAPI document). It is plain TypeScript
  with zero dependencies (only native `fetch`) and runs directly under
  Node.js's native TypeScript execution, no build step — developers can
  import it as-is or copy it as a starting point for their own client.
  **Its constructor now takes the auth token as a required second
  argument** — `new SwarmClient(baseUrl, authToken)` — and attaches
  `Authorization: Bearer <token>` to every request it makes; this is a
  breaking change from the previous single-argument form, and there is no
  unauthenticated mode. See the Authentication subsection above for where
  that token comes from.
  Every method accepts an optional trailing `signal?: AbortSignal` so a
  caller can bound a request (e.g. `client.getCapacity(AbortSignal.timeout(2000))`);
  the client itself imposes no default or automatic timeout.
  On a `401`, every method throws rather than returning a value: the
  boolean-returning ones (`heartbeat`, `recordAgreement`,
  `recordDisagreement`, `peerHeartbeat`, `deregisterPeer`) still return
  `false` for a genuine "no such id", but an auth failure is not an answer
  to that question and is raised instead of being flattened into the same
  `false`.

**`POST /generate` (and `SwarmClient.generate()`) is the one inference-request
path that exists today** — both the OpenAPI document and `SwarmClient`
describe/wrap it the same way as every other route. See the Coordinator
service section above for what it requires (a running, registered
`swarm-node-agent` with a matching `servesModel`) and what it still doesn't
do (dynamic node selection, pre-warming, or streaming — Phases B–D of the
request-routing design).

## Web client

When the coordinator is running, it serves a small browser dashboard at `/`
(plain HTML/CSS/vanilla JS — no build step, no framework, no new npm
dependency; the files live in `coordinator/public/` and are served by the
`GET /`, `GET /app.js`, and `GET /style.css` routes listed in the endpoint
list above). It shows:

- **Swarm status** — the active node count (local + federated, from
  `GET /capacity`) and the model catalog with each entry's minimum
  active-node threshold and current availability (from `GET /catalog`),
  polled every 5 seconds.
- **A `/classify` demo** — a text box and button that submit a prompt to
  `POST /classify` and display the resulting `safe`/`categories` verdict.

**The dashboard's own demo button does not run real inference.** It only
calls `POST /classify`, not `POST /generate` — a real inference-request
endpoint exists and works (see the Coordinator service section above), but
this dashboard was never wired up to call it, and the client visibly
discloses this gap in its own UI rather than faking it. The client is
same-origin only, and now requires an operator to paste a valid
`SWARM_AUTH_TOKEN` into the dashboard's token field (kept in the browser
tab's `sessionStorage`, sent as `Authorization: Bearer <token>` on every
`/capacity`, `/catalog`, and `/classify` call) — matching the coordinator's
Authentication requirement described above; this means anyone who has the
token, not literally anyone, can use the dashboard. As with the `/classify` endpoint
itself (see above), the shipped classifier has zero rules by default, so
the demo currently reports every prompt as `safe: true`; the dashboard's
own notice discloses this.
