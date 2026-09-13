# Endpoint Identity Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one physical listening socket resolve to one identity regardless of which alias string registered it, and make it impossible for a third party to forge or strip what an endpoint reports about itself.

**Design:** [`docs/superpowers/specs/2026-09-13-endpoint-identity-hardening-design.md`](../specs/2026-09-13-endpoint-identity-hardening-design.md) — read it first; this plan implements it, it does not re-derive it.

**Architecture:** A new pure `endpoint_identity.ts` canonicalizes `scheme://host:port` down to a `canonicalHost:port` identity key (loopback forms collapsed, trailing dot stripped, DNS-resolved via an injected resolver). `NodeRegistry.stableNodeId()` and `LauncherRegistry`/`claimedLauncherIds()` key on that instead of the raw string. Separately, `POST /nodes/register` and `POST /launchers/register` call a new `POST /identity` route on the claimed endpoint with a single-use nonce, and store the fields **the endpoint itself reports** rather than the caller's claims. `swarm-node-agent` gains `--serves-model`/`--device-tier` so it has something authoritative to report; `swarm-launcher` passes the former through when spawning.

**Tech Stack:** C++17 (`core/`, CMake+Ninja, GoogleTest via ctest) + Node.js 22.6+ native TypeScript (`coordinator/`, zero npm dependencies, `node:test`).

## Global Constraints

- **Never add a `Co-Authored-By: Claude` trailer to any commit.** State this in every dispatch — it does not carry over automatically.
- C++: build via `cmake -G Ninja -S . -B build && cmake --build build`. Test via `cd build && ctest`. Environment prelude for every C++ command: `export PATH="/c/msys64/ucrt64/bin:$PATH"; export CCACHE_DIR=/c/Users/User/.ccache`.
- **No new C++ dependency.** `core/` links only `llama`, `ggml`, `ws2_32`. Building JSON responses uses the existing `jsonEscapeString()`; parsing uses the existing `extractJsonString()`/`extractJsonInt()`/`extractJsonBool()` in `core/include/swarm/json_utils.h`. Do not extend those toward a general JSON parser — their own header forbids it.
- **Coordinator: zero npm dependencies.** Only `node:http`, `node:test`, `node:assert/strict`, `node:crypto`, `node:dns`, native `fetch`, `AbortSignal.timeout`. `node:dns` is a builtin and is the one newly-used module; adding anything non-`node:` is forbidden.
- **No TypeScript parameter properties** (`constructor(private readonly x: T)`) — Node's strip-only mode throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` and the module fails to load. Use explicit fields + assignment.
- **Apply every identity rule symmetrically, in the same task that introduces it.** Phase C needed three whole-branch review rounds because a rule was applied where a symptom was observed rather than everywhere the mechanism lives. If a task changes how identity is derived, it changes *every* site that derives it, or it is not done.
- **This phase is NOT dormant in production**, unlike Phases B and C. It changes registration for every node and launcher in every deployment, including single-node models. Treat every task as touching the live path.
- **Strict mode, no grace period** (resolving the design's Open Question 1): an agent that does not answer `POST /identity` cannot register. Both binaries ship from this repo, there is no external fleet to migrate, and a lenient "register anyway, flag unverified" mode would leave the exact forgeable path this phase exists to close. This is a **breaking protocol change** and must be stated in README.

---

### Task 1: `endpoint_identity.ts` — canonicalization

**Files:**
- Create: `coordinator/src/endpoint_identity.ts`
- Test: `coordinator/tests/endpoint_identity.test.ts`

**Interfaces:**
- Produces: `type HostResolver = (hostname: string) => Promise<string>`; `canonicalizeEndpoint(endpoint: string, resolve?: HostResolver): Promise<string>` returning a `host:port` identity key; `isLoopbackAddress(address: string): boolean`. Tasks 4, 5, 6 and 7 all depend on this exact signature.
- Consumes: `node:dns`'s `promises.lookup` as the default resolver.

**Behaviour to implement:**

1. Parse with `new URL(endpoint)`; throw a `TypeError` for anything unparseable (callers already validate, this is defence in depth).
2. Take `url.hostname`, lowercase it, strip **one** trailing dot.
3. Strip surrounding brackets from an IPv6 literal (`[::1]` → `::1`).
4. Resolve the port: `url.port` if present, else `443` for `https:`, else `80`.
5. If the host is already an IP literal, skip DNS. Otherwise resolve it via `resolve`. **On any resolver error, fall back to the literal hostname** — availability over strictness; a node on a name this coordinator cannot resolve must still be registerable.
6. If the resulting address is loopback, replace it with the fixed token `loopback`. Loopback means: `::1`, or an IPv4 in `127.0.0.0/8`, or the literal hostname `localhost`.
7. Return `` `${canonicalHost}:${port}` ``. Scheme is deliberately excluded.

**Tests to write first** (at minimum):

- `http://127.0.0.1:8080`, `http://localhost:8080`, `http://[::1]:8080`, and `http://LocalHost.:8080` all produce the **same** key.
- `http://127.0.0.1:8080` and `http://127.0.0.1:8081` produce **different** keys (a port genuinely distinguishes two agents on one machine).
- `http://example.com` and `https://example.com` produce **different** keys (`example.com:80` vs `example.com:443`). Excluding the scheme does not merge them: they are different listening sockets, and the resolved default port is what distinguishes them. Assert this explicitly so the rule is pinned rather than incidental.
- `http://example.com:443` and `https://example.com` produce the **same** key — the same socket reached two ways. This is the case that proves scheme is genuinely excluded rather than just unused.
- Two distinct names resolving (via an injected resolver) to the same IP produce the same key.
- A resolver that **throws** falls back to the hostname and does not reject.
- An IP literal never calls the resolver (assert with a spy resolver that throws if called).

- [ ] **Step 1:** Write the failing tests. Read an existing pure-module test (`coordinator/tests/pipeline_selector.test.ts`) first to match house style.
- [ ] **Step 2:** Run them, confirm they fail, report the actual failure text.
- [ ] **Step 3:** Implement `coordinator/src/endpoint_identity.ts`.
- [ ] **Step 4:** Targeted tests pass.
- [ ] **Step 5:** Full suite (`cd coordinator && npm test`) — 0 failures.
- [ ] **Step 6:** Commit: `Add endpoint_identity.ts: canonicalize an endpoint to a host:port identity key`

---

### Task 2: `swarm-node-agent` gains `--serves-model`, `--device-tier`, and `POST /identity`

**Files:**
- Modify: `core/src/node_agent_main.cpp`
- Test: `core/tests/node_agent_test.cpp`

**Interfaces:**
- Produces: `POST /identity`, auth-gated exactly like `/health` and `/complete`. Request `{"nonce":"..."}`. Response `200 {"nonce":"<echoed>","servesModel":"<--serves-model>","deviceTier":"<--device-tier>"}`. Missing/non-string `nonce` → `400`. Bad/absent auth → `401`. Task 6 depends on this shape.
- New flags: `--serves-model <id>` (optional; omit the field from the response when unset) and `--device-tier <desktop|android|ios>` (default `desktop`).

**Notes:**
- Read `core/src/node_agent_main.cpp` in full first, and match `/health`'s existing `isAuthorized(req, authToken)` pattern exactly.
- Build the response with `jsonEscapeString()` — the nonce is attacker-influenced input being echoed into JSON, so it **must** be escaped, not concatenated raw. Add a test with a nonce containing `"` and `\` proving the response is still valid JSON.
- Reject an over-long nonce (cap at 200 chars) with `400` rather than echoing unbounded input.
- Validate `--device-tier` against the three valid values at startup; exit non-zero on anything else, matching how `--model`/`--port` are validated.

- [ ] **Step 1:** Read the file; write failing tests (auth required, nonce echoed, missing nonce → 400, escaping, flags reflected).
- [ ] **Step 2:** Build, run, confirm failures, report actual output.
- [ ] **Step 3:** Implement the flags and the route.
- [ ] **Step 4:** Targeted tests pass.
- [ ] **Step 5:** Full `ctest` — no regressions.
- [ ] **Step 6:** Commit: `Add POST /identity and --serves-model/--device-tier to swarm-node-agent`

---

### Task 3: `swarm-launcher` gains `POST /identity` and passes `--serves-model` when spawning

**Files:**
- Modify: `core/src/launcher_main.cpp`
- Test: `core/tests/launcher_test.cpp`

**Interfaces:**
- Produces: `POST /identity`, **no auth check** — matching `POST /pipeline`/`DELETE /pipeline`'s existing deliberate no-auth, `127.0.0.1`-bind-only posture. Adding auth to one launcher route would be inconsistent; do not. Response `200 {"nonce":"<echoed>","agentPort":<--agent-port>}`.
- The launcher must **not** claim a `servesModels` field: it genuinely does not know what it serves (it can spawn anything in `--models-dir`). Do not invent one.
- `POST /pipeline`'s spawn argv gains `--serves-model <model>`, using the `model` value it already receives and validates.

**Notes:**
- Read `core/src/launcher_main.cpp` in full first. The spawn argv is built around line 308 (`agentArgv`).
- The same nonce-escaping and length-cap rules as Task 2 apply.
- Do **not** weaken the existing `model` path-traversal guard (rejects `/`, `\`, `:`, `..`) when threading the value into argv.

- [ ] **Step 1:** Read the file; write failing tests (nonce echoed, agentPort reported, no auth required, spawned argv contains `--serves-model`).
- [ ] **Step 2:** Build, run, confirm failures, report actual output.
- [ ] **Step 3:** Implement.
- [ ] **Step 4 / 5:** Targeted then full `ctest`.
- [ ] **Step 6:** Commit: `Add POST /identity to swarm-launcher and pass --serves-model when spawning`

---

### Task 4: `NodeRegistry` keys identity on the canonical key

**Files:**
- Modify: `coordinator/src/registry.ts`, `coordinator/src/server.ts` (all `registry.register(...)` call sites)
- Test: `coordinator/tests/registry.test.ts`, `coordinator/tests/server.test.ts`

**Interfaces:**
- `stableNodeId(identityKey: string)` now takes a **canonical key**, not a raw endpoint. Its doc comment must be rewritten — the existing one explains identity in terms of the endpoint string and would become actively misleading.
- `NodeRegistry.register()` gains an `identityKey` parameter. `NodeInfo.endpoint` stays the **contact URL**, unchanged — the coordinator must keep fetching exactly what was registered (IP substitution would break TLS SNI and name-based vhosts).

**Every call site must move in this task**, including:
- `POST /nodes/register` in `server.ts`.
- The launcher-spawned driver registrations inside `assemblePipeline()` (`server.ts`) **and** `tryAssemble()` (`pipeline_pool_manager.ts`) — these are the asymmetry trap Phase C fell into three times. Grep for `registry.register(` and fix every hit.
- Phase C's ejected-driver pre-flight derives a prospective driver id via `stableNodeId(...)` in **both** `server.ts` and `pipeline_pool_manager.ts`. Both must derive it the same new way or the guard silently stops matching.

- [ ] **Step 1:** `grep -n "stableNodeId\|registry.register(" coordinator/src/*.ts` and enumerate every site in your report before editing.
- [ ] **Step 2:** Write failing tests: a node registered as `127.0.0.1:P` and re-registered as `localhost:P` is **one** entry with one `nodeId` and one preserved reputation record.
- [ ] **Step 3:** Confirm failures; report actual text.
- [ ] **Step 4:** Implement across every site.
- [ ] **Step 5:** Full suite — 0 failures.
- [ ] **Step 6:** Commit: `Key node identity on a canonical host:port rather than the endpoint string`

---

### Task 5: `LauncherRegistry` and the claim tally key on the canonical key

**Files:**
- Modify: `coordinator/src/launcher_registry.ts`, `coordinator/src/pipeline_pool_manager.ts`
- Test: `coordinator/tests/launcher_registry.test.ts`, `coordinator/tests/pipeline_pool_manager.test.ts`

**Interfaces:**
- `LauncherInfo` gains `identityKey: string`. `register()` matches an existing launcher on `identityKey` instead of raw endpoint equality.
- `claimedLauncherIds()` tallies `identityKey` (alongside `launcherId`, which still rotates); `isLauncherClaimed()` compares on it. **Both must change together** — they are the pair Phase C's round-2 review caught being out of step.
- `PooledPipeline.launcherEndpoint` stays (teardown still needs a contact URL when a registration has lapsed); add the identity key alongside it rather than replacing it.

**The headline test for this task:** one launcher registered as `http://127.0.0.1:P` and `http://localhost:P` must be recognised as **one** machine, so a second model cannot claim it. This is the exact live-verified wrong-model-served bug from Phase C's third review.

- [ ] **Step 1–3:** Failing tests first, confirm, report.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Full suite.
- [ ] **Step 6:** Commit: `Key launcher identity and the claim tally on a canonical host:port`

---

### Task 6: endpoint-authoritative registration (`POST /identity` callback)

**Files:**
- Modify: `coordinator/src/server.ts`
- Test: `coordinator/tests/server.test.ts`

**Interfaces:**
- `POST /nodes/register` and `POST /launchers/register` each: generate a nonce (`randomUUID()`), `POST` it to `${endpoint}/identity` with the bearer token and `AbortSignal.timeout(IDENTITY_TIMEOUT_MS)` (5000), require an exact nonce match, and **store the endpoint's reported fields over the caller's**.
- Failure responses must distinguish causes: endpoint unreachable/timed out → `502` with a message naming the endpoint; nonce mismatch → `502`; malformed caller body → `400` (unchanged).
- `POST /peers/register` gets **no callback** — a peer is another coordinator with no agent `/identity` route. State this asymmetry in the code comment and README.
- The **internal** launcher-spawned driver registrations (`assemblePipeline`, `tryAssemble`) must **skip** the callback: the coordinator just spawned that agent and it may not be listening yet. Add a distinct internal path rather than making the callback optional-by-flag on the public route.

**Per-field rules** (from the design's table — do not over-claim):
- `servesModel`, `deviceTier`: taken from the agent's answer, caller's values ignored.
- `localityGroup`, `availableMemoryMb`: still caller-supplied, still unverified. Leave them, and do not imply otherwise in any comment or doc.
- Launcher: only liveness and `agentPort` are confirmed; `servesModels` stays caller-supplied and disclosed.

**Tests must include** a registration attempt against an endpoint that answers with the **wrong** nonce, one that 404s (an old agent), one that hangs past the timeout, and one proving a third party re-registering a live node's endpoint **cannot** strip its `servesModel` — the griefing primitive this phase closes.

- [ ] **Step 1–3:** Failing tests first (use the `startStubNodeAgent` pattern already in `server.test.ts`), confirm, report.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Full suite.
- [ ] **Step 6:** Commit: `Verify registrations against the endpoint itself with a single-use nonce`

---

### Task 7: `PeerRegistry` canonicalization, plus the documented developer surface

**Files:**
- Modify: `coordinator/src/peer_registry.ts`, `coordinator/src/openapi.ts`, `coordinator/src/client.ts`
- Test: `coordinator/tests/peer_registry.test.ts`, `coordinator/tests/client.test.ts`

**Interfaces:**
- `PeerRegistry` canonicalizes for dedup (no callback — see Task 6).
- `openapi.ts`: document the new `502` failure mode on both register routes, and that `servesModel`/`deviceTier` are now endpoint-reported rather than caller-declared. This project has blocked merges twice on `openapi.ts` contradicting the code; do not leave it stale.
- `client.ts`: `SwarmClient.registerNode()`'s doc comment must say the endpoint must be live and answer `/identity`, since registration can now fail for that reason.

- [ ] **Step 1–5:** Tests first, implement, full suite.
- [ ] **Step 6:** Commit: `Canonicalize peer endpoints; document endpoint-verified registration`

---

## Whole-branch review

Per `CLAUDE.md`, on the most capable model, **with live adversarial probing** — a real coordinator, a real `swarm-node-agent`, a real `swarm-launcher`, real HTTP. Reading the diff is not sufficient.

Must specifically verify:
- One machine under several aliases is one identity, for **both** nodes and launchers, including the Phase C wrong-model-served reproduction.
- A third party cannot strip or forge a live node's `servesModel`.
- The DNS-collision attack (point a name at someone else's IP) fails.
- An agent without `/identity` is cleanly rejected, not silently accepted.
- Registration latency and the timeout path behave under a hung endpoint.
- Every `stableNodeId`/`registry.register`/claim-tally site derives identity the same way — enumerate them and check each, rather than sampling.

## What This Plan Does Not Do

- **No Sybil resistance.** Distinct endpoints and ports are still distinct identities, and a token-holder can still register many. Canonicalization makes reputation-resetting cost something; it does not make it impossible. Do not let any doc imply otherwise.
- **No public-key identity.** Rejected for a concrete reason (no crypto library in `core/`); see the design's Non-goals.
- **No TLS, no per-node credentials.** Still one swarm-wide `SWARM_AUTH_TOKEN`.
- **Does not verify `localityGroup` or `availableMemoryMb`**, and does not measure anything a node claims about itself.
- **Does not close reputation-rehab-in-place** (6 `agree` calls) — unrelated to identity, still open.
- **Does not make cross-operator federation work** — that gap is untouched here.
