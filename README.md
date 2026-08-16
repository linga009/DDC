# swarm-llm

A native C++ inference engine (`swarm::InferenceEngine`, a wrapper around
[llama.cpp](https://github.com/ggml-org/llama.cpp)) and a `swarm-cli`
command-line executable for running local LLM inference.

This repo implements five foundational plans from the project vision: a
local, single-device inference engine; a first step into multi-node
sharding via a minimal RPC mechanism; a coordinator service that tracks
node liveness and gates model availability by capacity (both described
below); explicit per-layer placement of Mixture-of-Experts tensors across
local and remote devices; and speculative decoding, which verifies several
draft-model-proposed tokens per target-model round-trip
(`InferenceEngine::complete_speculative`, not yet exposed via `swarm-cli`).
Federation across independently-run coordinator instances now covers peer
registration, liveness, and capacity aggregation into `/catalog`; it does
not yet cover cross-instance request routing (an instance handing a client
off to a peer's nodes to actually run inference) — see
[`docs/superpowers/specs/2026-08-14-distributed-llm-inference-design.md`](docs/superpowers/specs/2026-08-14-distributed-llm-inference-design.md)
for the full design of where this is headed.

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
> exactly this reason.

## Coordinator service

`coordinator/` is a small HTTP service that tracks which nodes are alive and
uses their count to gate which models in the catalog are announced as
available. It requires Node.js 22.6+ (native TypeScript support — no build
step, and it has zero npm dependencies).

Run its tests:

```bash
cd coordinator && npm test
```

Start it:

```bash
PORT=8080 node src/main.ts
```

Endpoints:

- `POST /nodes/register` — register a node, returns a `nodeId`
- `POST /nodes/:nodeId/heartbeat` — refresh a node's liveness
- `GET /nodes` — list currently active nodes
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
  interface (`coordinator/src/safety_classifier.ts`).** `/classify` is also
  not yet wired into any request-submission path — nothing currently calls
  it automatically before routing a prompt for inference.
- `POST /nodes/:nodeId/reputation/agree` / `POST /nodes/:nodeId/reputation/disagree`
  — record that a node's output agreed or disagreed with a redundant
  spot-check computation (204, or 404 if `nodeId` is unknown)
- `GET /nodes/:nodeId/reputation` — report a node's reputation stats:
  `{ agreements: number, disagreements: number, trusted: boolean }`

A node with zero recorded checks is trusted by default. Ejection (excluding
the node from `GET /nodes`, `GET /capacity`, and `/catalog`'s active-node
count) requires both a minimum sample size and a disagreement rate at or
above threshold — the defaults are `minSamples=5` and
`disagreementThreshold=0.5`, and neither is currently runtime-configurable
(both are `ReputationTracker` constructor parameters, hardcoded at their
defaults in `main.ts`). This means a node doesn't eject on a single sample.
This is not a defense against a malicious caller — the minSamples/threshold
gate exists to absorb noisy or unlucky spot-check results, not adversarial
ones; see the no-auth caveat below. **The coordinator does not implement
the actual redundant-computation spot-check mechanism** (running the same
request on two nodes and comparing outputs) — that requires a
request-routing system this repo doesn't have yet. It only builds the
reputation ledger and ejection policy, ready to be wired in once routing
exists. Reputation endpoints themselves stay operable on an
already-ejected node (so future spot-check results can still be recorded
for it) — only capacity-facing views exclude it.

**Caveat:** there is no authentication, and by default the server binds only
to `127.0.0.1`; setting `HOST` to bind wider (e.g. `0.0.0.0`) should only be
done on trusted networks. Federation compounds this: once a peer is
registered, this instance makes an outbound HTTP request to it on every
`GET /catalog` call, and `POST /peers/register` itself is unauthenticated,
so anyone able to reach this instance can add outbound request targets.
The reputation-recording endpoints are likewise unauthenticated — currently
any caller can record arbitrary agreement/disagreement events for any node.
Reputation state is in-memory only and does not persist across restarts.

**Known gaming vectors:** reputation is keyed by `nodeId`, and
`NodeRegistry.register()` mints a fresh `randomUUID()` on every call with no
endpoint dedupe (unlike `PeerRegistry`, which dedupes registrations by
endpoint) — so an ejected node clears its record with one more
`POST /nodes/register` call, restoring its `/capacity` count immediately.
Verified live: 5 disagreements ejects a node; one re-register call and
it's back with a clean slate. This is a stronger, cheaper vector than a
node simply avoiding ever being spot-checked to stay perpetually
"unproven, therefore trusted" under the zero-checks-trusted default above.
Separately, the disagreement ratio is all-time with no decay or windowing,
so an established node with a long good history (e.g. 200 agreements)
needs 200 *consecutive* disagreements to be ejected — the inverse of
catching a node that goes bad (compromised, degraded hardware) after
building trust, and effectively un-ejectable at any realistic spot-check
sampling rate. Fixing the first requires stable node identity
(endpoint-keyed or node-supplied public key); fixing the second requires a
sliding window or EWMA scoring function instead of a lifetime ratio. Both
are out of scope for this ledger-only plan and are prerequisites for the
future spot-check-mechanism plan. Note also that because every
registration mints a fresh reputation entry with no eviction, a churning
fleet leaks one entry per registration in the in-memory `Map` — the same
stable-identity fix needed above would address this too; evicting on
registry-prune alone is not attempted here, since it would open a new
evasion path (go quiet for 30s to get a clean slate).
