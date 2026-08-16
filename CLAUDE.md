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
- Every piece of state in this service (`NodeRegistry`, `PeerRegistry`, `ReputationTracker`) is **in-memory only, not persisted across restarts** — a deliberate, disclosed limitation, not a gap to silently fix.
- **No authentication on any endpoint** — deliberate, disclosed, trusted-LAN-scope-only posture, matched consistently across every endpoint added so far (including self-reported fields like `deviceTier` and `localityGroup`). If you add auth, it changes the threat model for the whole service — raise it explicitly, don't bolt it onto one endpoint.
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

**All 11 plans complete.** The repo now has: a working single/multi-node C++ inference engine with speculative decoding and MoE layer placement; a federated Node.js coordinator with node/peer registries, capacity-gated model catalog, a safety-classifier gate (ships with zero rules by default — disclosed, not solved), a reputation/ejection ledger, locality-aware node grouping, a browser dashboard, and a documented+typed developer API. The connective tissue still missing, called out in every plan since Plan 6: no request-routing or pipeline-assembly system exists yet, so no client can get an actual generated response end-to-end. That is the natural next major initiative.

**Plan 10 scope note:** the master spec originally called for native Android/iOS/Linux/Windows/macOS client apps. This dev environment is Windows-only with no mobile/desktop client toolchain installed, and iOS is categorically impossible to build/test without a Mac — when asked, the user chose to rescope Plan 10 to a browser-based dashboard served directly by the coordinator (`GET /`, `/app.js`, `/style.css`) instead. It shows live swarm status and a `/classify` demo; it does not attempt real inference, and its `/classify` demo is backed by the same zero-rule default classifier as the endpoint itself (see the "Coordinator" section below) — both gaps are visibly disclosed in the page's own UI, not just in docs. Native apps remain undesigned and deferred.

None of Plans 1–9 implement actual multi-hop request routing or pipeline
assembly end-to-end — each one built the piece the spec calls for
(sharding mechanics, capacity tracking, federation, safety gate, reputation
ledger, locality grouping) *ready to be wired into* a routing system that
doesn't exist in this repo yet. That routing system is the connective
tissue still missing across every plan so far — keep this in mind when
scoping Plans 10/11 or any future plan that assumes requests are actually
flowing end-to-end today.
