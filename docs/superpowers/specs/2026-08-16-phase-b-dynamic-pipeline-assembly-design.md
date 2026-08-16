# Phase B: Dynamic Pipeline Assembly — Design

> Forward-looking design, written before any implementation. Unlike this
> project's other specs (which were validated by building against them),
> nothing here has been tested yet — treat the open questions and risks
> sections as seriously as the architecture itself.

## Summary

Phase A (done, merged) proved the whole request path works — classify,
route, forward, respond — but pipeline composition is entirely
operator-configured: someone manually starts `swarm-node-agent` with fixed
`--remote`/`--layer-placement` flags, and manually registers it with a
`servesModel`. Phase B replaces the manual step with the coordinator
deciding, from its own live registry/reputation/locality state, which
nodes should form a pipeline for a given model — and actually causing that
pipeline to exist, not just declaring an opinion about it.

## Goals

- Given a model that needs a multi-node pipeline, have the coordinator
  select which nodes should participate — driver (holds the model,
  receives `/complete` calls) and compute contributors (run
  `swarm-rpc-server`, no model) — using the registry, reputation, and
  locality data every prior plan already built.
- Actually cause that selection to become a running, HTTP-reachable
  pipeline, not just a decision on paper.
- Track pipeline lifecycle (assembling / warm / failed / torn down) as a
  first-class coordinator concept that `/generate`'s node-selection step
  reads from, instead of today's flat "any active node with matching
  `servesModel`" scan.

## Non-Goals

- **Multiple concurrent warm pipelines per model, or scaling their count
  with demand** — that's Phase C. Phase B assumes one pipeline per model
  is enough to prove dynamic assembly works; Phase C is what makes the
  *count* dynamic.
- **Triggering assembly proactively, ahead of a request arriving** — also
  Phase C (pre-warming). Phase B can be built and tested with
  assembly triggered synchronously by the first request that needs a
  pipeline that doesn't exist yet, accepting the latency cost, and then
  Phase C moves that trigger earlier.
- **Token streaming** — Phase D, unrelated axis.
- **Changing `InferenceEngine`'s sharding logic** — Phase B only decides
  *which* nodes and *what* layer placement to pass to the existing,
  unchanged constructors.

## The Central Architectural Constraint

`swarm-node-agent` (Phase A) loads a model and constructs its
`InferenceEngine` exactly once, at process startup, from CLI flags. There
is no API to reconfigure an already-running agent's pipeline shape — doing
so would mean destroying and reconstructing the `InferenceEngine`, which
means reloading the model from disk, which takes real, non-trivial time
(observed: low seconds for TinyLlama-1.1B on this dev machine; larger
models and cross-network `--remote` connection setup would add more).

This rules out the simplest-sounding design ("send the running agent a
new pipeline config over HTTP") as a *fast* mechanism — it would work, but
every reassembly would cost a full model reload, which is disqualifying if
reassembly needs to happen often (e.g., every time a node's reputation
changes).

**Given this constraint, Phase B's real design question isn't "how do we
pick good nodes" (that part is a straightforward scoring problem over data
this project already has) — it's "how do we cause a process, possibly on
a machine the coordinator doesn't control directly, to start running with
a specific pipeline shape."**

## Proposed Architecture

Introduce a small, new role: a **launcher** — a lightweight, always-running
HTTP service on any machine willing to be a pipeline "driver" (i.e., hold
model weights and run `swarm-node-agent`). The launcher's only job is
process lifecycle: given `{model, remoteEndpoints, layerPlacements, port}`,
it starts (or restarts) a `swarm-node-agent` child process with those
exact flags, and reports back once `/health` on the new process is green.

```
[Coordinator]
     | decides pipeline shape from registry/reputation/locality
     | POST http://<driver-host>:<launcher-port>/pipeline
     |   {model: "tinyllama-1.1b", remoteEndpoints: [...], layerPlacements: [...], agentPort: 8081}
     v
[Launcher, on the driver machine]
     | kills any swarm-node-agent it previously started (if reassembling)
     | spawns: swarm-node-agent --model <path> --port 8081 --remote ... --layer-placement ...
     | polls the new process's /health until 200
     v
     responds 200 to the coordinator once the agent is confirmed ready
     |
[Coordinator]
     | registers the now-ready agent's endpoint + servesModel automatically
     | (no more manual POST /nodes/register step for driver-launched agents)
     v
     marks the pipeline "warm" in its own tracking, ready for /generate
```

This keeps every existing piece unchanged: `swarm-node-agent` gains no new
API surface, `InferenceEngine` is untouched, and the coordinator's
`/generate` logic still just picks a `servesModel`-matching active node —
it just now increasingly gets that node from launcher-driven assembly
instead of a human running a command by hand.

**Why a separate launcher, not extending `swarm-node-agent` itself:**
`swarm-node-agent` deliberately has zero process-management responsibility
today — it loads once and serves forever, mirroring `swarm-rpc-server`'s
established "does one thing" posture in this repo. Teaching it to
supervise/replace itself would blur that boundary and complicate its
already-reviewed lifetime/lambda-capture reasoning (see Plan 12's
whole-branch review) for a concern that's genuinely separate: the launcher
manages *processes*, the agent serves *inference*.

## Node Selection (the scoring problem)

Given a model needing a pipeline, and the coordinator's live
`NodeRegistry`/`ReputationTracker`/locality-group state:

1. Filter to nodes that are `listActive(reputation)`-trusted — reuses the
   existing choke point, no new filtering logic.
2. Among trusted nodes, prefer a **driver** candidate with the most
   available memory/compute for the model size (this repo doesn't
   currently track per-node capability beyond `deviceTier` — a real open
   question, see below).
3. Prefer **compute contributors** from the same `localityGroup` as the
   driver, before falling back to nodes with no shared locality group —
   this is precisely what `GET /nodes/locality` (Plan 9) was built as
   groundwork for, and it directly matters for latency: same-LAN hops are
   ~1ms, cross-internet hops are 50-200ms+, and every token in a
   pipeline-sharded model pays that cost per hop.
4. Layer placement: for MoE models, bias toward placing whole layers on
   whichever device already holds adjacent layers, to avoid pathological
   placements that maximize cross-device chatter within a single forward
   pass.

## Open Questions (unresolved — flag for whoever picks this up)

- **No per-node capability data exists yet.** `deviceTier` (desktop/
  android/ios) is the only signal `NodeRegistry` has; it says nothing
  about available RAM, active connection bandwidth, or current load. A
  driver selection that doesn't account for this could pick a node that
  fails to load the model at all. This may need a new self-reported (and,
  per this project's established posture, unverified) field before Phase
  B can make good decisions — worth deciding whether to add it here or
  treat capability-awareness as its own follow-up.
- **What triggers reassembly when a pipeline's node set goes stale**
  (a compute node ages out of the registry, or gets reputation-ejected)?
  Phase B needs *some* answer even without Phase C's full lifecycle
  machinery — the minimum viable one is probably "the next `/generate`
  call for that model, if the tracked pipeline's nodes are no longer all
  active, triggers a fresh launcher call" (synchronous, accepting the
  reload latency) — explicitly deferring anything smarter to Phase C.
- **Launcher trust and security.** The launcher accepts commands to spawn
  arbitrary local processes with coordinator-supplied arguments. This is
  a materially larger blast radius than anything built so far (every
  existing gap is "record wrong data" or "receive traffic meant for
  someone else"; a compromised or malicious coordinator commanding a
  launcher is "run an arbitrary command line on my machine"). Given this
  project's no-auth posture is a deliberate, disclosed choice for the
  *coordinator* API, the launcher probably needs its own, different
  security posture from day one — worth deciding explicitly rather than
  copying the no-auth pattern by default. This is the single biggest open
  risk in this design and deserves real discussion before implementation
  starts, not just before merge.
- **What if no launcher is available for a needed driver role** (e.g., the
  only trusted nodes are phones, which per the spec's own device-tiering
  are unlikely to be viable drivers for anything but the smallest models)?
  Falling back to Phase A's manual-registration path indefinitely for
  those cases is probably fine and worth stating explicitly as acceptable
  degradation, not a gap to close.

## Testing Considerations (for whenever this gets implemented)

- The launcher is a new process-spawning surface — needs the same rigor
  Plan 12's `HttpServer` got: real subprocess spawning in tests (not
  mocked), adversarial input handling (a malformed model path, an
  unreachable remote endpoint), and resource cleanup verification
  (orphaned child processes left running after a test are a real risk
  with this kind of code, as this project's own model-loading test
  fixtures have had to guard against with `taskkill`/`pkill` cleanup).
- Node-selection scoring should be tested as a pure function, independent
  of the launcher/HTTP plumbing — given the registry's current state and
  a target model, does the scorer pick the node set a human would expect?
- A live, adversarial whole-branch review (this project's established,
  consistently bug-finding practice) is essential here given the launcher
  introduces a genuinely new class of risk (remote code execution
  surface) that nothing built so far has had.
