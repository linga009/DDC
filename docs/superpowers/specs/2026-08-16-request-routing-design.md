# Request Routing & Pipeline Assembly — Design

## Summary

Every plan built so far (1 through 11) produces working, tested infrastructure, but none of it is wired together: there is no path from "a client submits a prompt" to "a real generated response comes back from the swarm." This spec designs that path. It targets the project's actual value proposition — real multi-node sharded inference, assembled dynamically by the coordinator from live, trusted, nearby capacity, kept warm ahead of demand and scaled to it — but scopes the *first* increment of that vision down to a walking skeleton: prove the full path end-to-end (classify → route → generate → respond) through a single, operator-configured multi-node pipeline, before building the dynamic assembly and autoscaling machinery on top of a foundation that's already proven to work.

## Goals

- Prove a client can submit a prompt to the coordinator and receive a real generated response, produced by `swarm::InferenceEngine` running on one or more networked nodes.
- Exercise genuine multi-node RPC-sharded inference (not single-device) as part of that path, since that's the project's core differentiator — not deferred to a later phase.
- Finally wire the existing, previously-unused `/classify` safety gate into an actual request path.
- Establish the node-agent pattern (a long-lived, HTTP-reachable process wrapping `InferenceEngine`) that later phases (dynamic assembly, autoscaling, streaming) build on without redesigning.

## Non-Goals (this spec; see Roadmap for when they're addressed)

- Dynamic, coordinator-driven selection of which nodes form a pipeline (Phase B).
- Background pre-warming of pipelines ahead of demand, or demand-based autoscaling of the warm-pipeline pool (Phase C).
- Token-by-token streaming to the client (Phase D) — `InferenceEngine::complete()` is fully synchronous with no per-token callback today; this spec's `/generate` path returns the complete response once generation finishes, same as `complete()` already behaves.
- Any change to `InferenceEngine`'s core sharding/placement logic — Phase A reuses the existing single-device, remote-device, and layer-placement constructors exactly as built in Plans 1/2/4.
- Web dashboard UI changes to actually display generated output (a small follow-up, not part of proving the backend path).

## Roadmap

- **Phase A (this spec) — Done, merged.** `swarm-node-agent` (Plan 12) + `POST /generate` (Plan 13), routing to one operator-configured pipeline. The walking skeleton — verified live, multiple times, producing real generated text end to end.
- **Phase B — [design written](2026-08-16-phase-b-dynamic-pipeline-assembly-design.md), not yet implemented.** The coordinator decides pipeline composition dynamically from live `NodeRegistry`/reputation/locality state, commands a new launcher role to assemble it, tracks pipeline lifecycle.
- **Phase C — [design written](2026-08-16-phase-c-prewarming-autoscaling-design.md), not yet implemented.** Background pre-warming (extending the existing capacity-gating logic so "available" in the catalog means "a warm pipeline actually exists," not just "enough nodes are registered") and demand-based autoscaling of the warm-pipeline pool per model.
- **Phase D — [design written](2026-08-16-phase-d-token-streaming-design.md), not yet implemented.** Token streaming — a new `InferenceEngine` per-token callback, plumbed through the node agent (Server-Sent Events), the coordinator, and the web client.

Each phase gets its own implementation plan once the phase before it is built and merged, following this project's established one-plan-at-a-time cadence. The B/C/D designs above were written before any of them were built — treat their open questions and risks sections as live, not settled, and revisit them at planning time rather than assuming they're still accurate.

## Architecture (Phase A)

```
  Client (web dashboard, curl, SwarmClient)
       |
       v  POST /generate {prompt, modelId, n_predict?}
  [Coordinator, Node.js]
       | 1. classify(prompt) -- reject if unsafe
       | 2. find an active, reputation-trusted node where servesModel === modelId
       | 3. forward {prompt, n_predict} to that node's endpoint + /complete
       v
  [swarm-node-agent, C++, long-lived]
       | already holds a constructed InferenceEngine (1+ devices, set at startup)
       | InferenceEngine::complete(prompt, n_predict) -- blocking
       v
  {text} flows back: node-agent -> coordinator -> client
```

**`swarm-node-agent`** (new, `core/src/node_agent_main.cpp`): loads a model and constructs an `InferenceEngine` once at startup — using whichever existing constructor matches the CLI flags given (single-device, remote-device, or layer-placement) — then serves a minimal HTTP interface for the rest of its process lifetime.

CLI, mirroring `swarm-cli`'s and `swarm-rpc-server`'s existing flag style:
```
swarm-node-agent --model <path.gguf> --port <N> [--remote host:port ...] [--layer-placement N:endpoint ...]
```
`--remote` and `--layer-placement` are optional and repeatable, mapped directly to `InferenceEngine`'s existing `remote_endpoints`/`LayerPlacement` constructor parameters — no new sharding logic, this only exposes what Plans 2 and 4 already built via a CLI surface that didn't exist before (today only `core/tests/` constructs multi-device engines directly in C++).

HTTP endpoints:
- `GET /health` — 200 once the engine is constructed and ready to serve; process is not listening at all until construction completes (model load + remote-device connection, which can take real time — this is a synchronous startup cost, not a per-request one).
- `POST /complete` — body `{"prompt": string, "n_predict": integer}` → `{"text": string}`. Blocking; one request at a time is the expected v1 usage pattern (no internal request queue/concurrency control — a second request arriving while one is in flight is out of scope for this phase; document it as a known limitation).

**New HTTP server code in `core/`:** this project's C++ side has had zero HTTP code — only llama.cpp's raw RPC backend. `swarm-node-agent` needs a minimal HTTP/1.1 server: enough to parse one `GET` and one `POST` with a small JSON body, and write a JSON response. This is hand-rolled (a small `core/src/http_server.cpp`/`.h`, scoped to exactly this need), not a pulled-in library — consistent with this project's established zero-unnecessary-dependency stance (llama.cpp's raw API only for `core/`, zero npm dependencies for `coordinator/`). This is genuinely new infrastructure and should be its own implementation task with its own tests (a raw socket client hitting it with real requests), separate from the task that wires it into `swarm-node-agent`.

**Coordinator changes (`coordinator/`):**
- `NodeInfo` (`registry.ts`) gains an optional `servesModel?: string` field, settable via `POST /nodes/register`'s existing body. When present, it must match a real `ModelCatalog` entry `id` (validated the same way `deviceTier` already is — reject with 400 on an unknown id) — a node agent registers itself this way to declare "I serve model `X` at my registered `endpoint`."
- New endpoint, `POST /generate`:
  - Body: `{"prompt": string, "modelId": string, "n_predict"?: integer}`. `n_predict` defaults to 64 if omitted, capped at 512 (reject with 400 if a caller supplies something outside `[1, 512]`) — bounds how long a single request can tie up a node.
  - Step 1: run `prompt` through the existing `classifier.classify()` (the same `SafetyClassifier` interface and fail-closed handling `/classify` already uses). If unsafe, respond `400 {safe: false, categories: [...]}` — same body shape `/classify` already returns, `400` because the request as submitted cannot be processed (consistent with how every other validation failure in this API already uses `400`, rather than introducing a new status-code precedent for this one path).
  - Step 2: find an active (`listActive(reputation)`), trusted node with `servesModel === modelId`. None found → `503` with a clear "no capacity for this model" body (distinct from `/catalog`'s `available` flag, which only reflects registered-node *count*, not whether a real serving node currently exists — a real gap between the two that this phase does not reconcile; Phase C's pre-warming is where `/catalog`'s `available` should start meaning "a warm pipeline actually exists").
  - Step 3: forward `{prompt, n_predict}` as a `POST` to the chosen node's `endpoint + "/complete"`. Node unreachable or errors → `502` with a clear body; do not silently retry a different node in this phase (single-attempt, fail loud — matches this project's disclosed-not-solved posture for gaps rather than adding resilience machinery not yet asked for).
  - Success: `200 {"text": string}`.
- `SwarmClient` (`coordinator/src/client.ts`) gains a `generate(prompt, modelId, n_predict?, signal?)` method, matching the established pattern for every other endpoint it wraps.
- `GET /openapi.json` gains the new `POST /generate` path (and the `servesModel` field on `/nodes/register`'s existing schema) — keeping the drift-detection test's coverage accurate, per Plan 11's established pattern.

## Data Flow (worked example)

1. Operator starts two `swarm-rpc-server` instances on two machines (unchanged from Plan 2).
2. Operator starts one `swarm-node-agent --model tinyllama... --port 9000 --remote host2:8001 --remote host3:8002`. It loads the model, connects to both remotes, and becomes ready.
3. Operator registers that agent with the coordinator: `POST /nodes/register {endpoint: "http://host1:9000", deviceTier: "desktop", servesModel: "tinyllama-1.1b"}`.
4. A client calls `POST /generate {prompt: "...", modelId: "tinyllama-1.1b"}` on the coordinator.
5. Coordinator classifies, finds the registered node, forwards to `http://host1:9000/complete`.
6. The node agent's already-warm, already-multi-device `InferenceEngine` runs `complete()`, using nodes 2 and 3's compute via the existing RPC mechanism.
7. Text flows back through the coordinator to the client.

Nothing about this differs by node count — the same path works for a single-device node agent (no `--remote` flags) or a many-device one; Phase A's "one pipeline" is just whatever the operator configured at agent startup, proving the whole cross-language, cross-process path works before Phase B makes node selection dynamic.

## Testing

- **`core/`:** a new test suite for the hand-rolled HTTP server (raw-socket client, real requests, malformed-input handling) and a new test for `swarm-node-agent` itself — spawned as a subprocess against the TinyLlama test model, hit with real HTTP requests via the same raw-socket or a minimal C++ HTTP client, verifying `/health` then `/complete` produce real output. A multi-node variant spawns a `swarm-rpc-server` child process first and passes `--remote` to the agent, mirroring Plan 2's existing subprocess-based test pattern for remote-device construction.
- **`coordinator/`:** the default, fast `npm test` suite tests `/generate`'s routing/classify/error-handling logic against a lightweight stub HTTP server standing in for a node agent (no real model, no C++ binary needed) — covers success, no-capacity (503), node-failure (502), classify-rejection, and validation (bad `modelId`, `n_predict` out of range) paths.
- **`coordinator/`, opt-in:** one real end-to-end test that spawns the actual built `swarm-node-agent` binary against the real TinyLlama test model, proving the cross-language bridge genuinely works, not just the routing logic in isolation. This requires the C++ build to have run and the test model to be downloaded first — a new, disclosed prerequisite for this one test only. It lives in its own file/npm script (`npm run test:e2e`, separate from the default `npm test`) so the fast suite that runs on every plan's TDD loop stays fast and dependency-free; the e2e test is run explicitly (e.g., once per phase's whole-branch review) rather than on every edit.

## Known Limitations (disclosed, not solved by Phase A)

- One request at a time per node agent — no queueing or concurrency handling.
- No retry or fallback to a different node on failure — single attempt, fail loud.
- `/catalog`'s `available` flag and `/generate`'s actual routability can disagree (a model can show `available: true` from registered-node *count* while no node has actually registered `servesModel` for it yet) — reconciled in Phase C.
- No streaming — the client waits for the complete response.
- No authentication anywhere in this path (matches every existing endpoint's disclosed no-auth, trusted-LAN-scope posture).
- Pipeline composition is entirely operator-configured (CLI flags at `swarm-node-agent` startup) — not dynamic, not fault-tolerant to a remote device disappearing mid-session (the underlying RPC mechanism's existing behavior, unchanged by this phase).
