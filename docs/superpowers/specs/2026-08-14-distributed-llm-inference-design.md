# Distributed Inference Network for Open-Weight LLMs

**Status:** Draft — approved by user, pending final review
**Date:** 2026-08-14

## Summary

An open-source, federated network that pools idle compute from volunteers'
phones, laptops, and desktops (Android, iOS, Linux, Windows, macOS) so
people can run open-weight LLMs too large for any single device, for free,
with no donation/token/incentive economy. Contribution is reciprocal by
design: your device helps host model shards, and in exchange you get access
to models the network can collectively serve. The set of models available
grows automatically as the network grows — small models run from day one;
bigger models unlock once aggregate capacity supports them.

The system is federated, not centrally hosted: anyone can run a coordinator
instance (in the spirit of Mastodon/Matrix), and instances federate with
each other. There is no single company or server that owns or controls the
whole network. This is a deliberate, harder design choice than a
centralized coordinator, made because it matches the project's premise —
crowd-contributed compute shouldn't depend on one company staying in
business or behaving well.

The project is open source from the start (client apps, coordinator,
protocol). Asking people to let software use their device's compute in the
background requires them to be able to verify it isn't doing anything
malicious — closed source is a trust blocker here, not just a nice-to-have.

This design is built as one integrated system rather than a staged feature
rollout — see [Build Scope](#build-scope) for what that means in practice,
and [Safety & Social Responsibility](#safety--social-responsibility) for
why federation makes that section load-bearing, not optional.

## Goals

- Serve inference for open-weight LLMs (starting small, scaling up) using
  pooled compute from volunteer devices — phones (Android, iOS) and
  laptops/desktops (Linux, Windows, macOS) — reachable over the internet.
- Ship both a consumer chat app and a developer-facing API on the same
  backend.
- Model catalog is pluggable: new open-weight models can be onboarded via a
  manifest, without redesigning the system.
- Federated hosting: anyone can run a coordinator instance; instances
  federate with each other rather than depending on one central server.
- No cryptocurrency, token, or donation-based incentive layer. Participation
  is reciprocal (you contribute capacity, you get access), not transactional.
- Open source, permissively licensed, built for community contribution to
  the client, coordinator, and protocol alike.
- Safety and contributor protection designed in from the start, not
  retrofitted after launch (see dedicated section below).

## Non-Goals

- **Not** targeting cloud-LLM response speed. Per-reply latency will be
  noticeably slower than ChatGPT/Claude/etc. The product is honest about
  this trade-off: bigger open models than any single device could run, for
  free, in exchange for patience.
- **Not** building a general decentralized storage network. Device storage
  is not a core pillar — especially for phones, which are unreliable as
  durable storage nodes (OS kills background apps, limited free space,
  constantly changing networks). If storage-like needs arise (e.g. caching
  shared knowledge-base chunks), that's a narrow, deferred feature.
- **Not** promising strong prompt privacy at launch. Prompts pass through
  intermediate strangers' devices as activations, not raw text — but
  activation-inversion attacks are an active research area and unsolved
  here. This is disclosed to users, not glossed over (see Safety section).
- **Not** claiming environmental superiority over datacenter inference.
  Many small, heterogeneous devices doing distributed matrix math are
  likely *less* energy-efficient per useful token than a well-utilized GPU
  cluster. The honest claim is "reuses idle hardware that already exists,"
  not "greener."
- **Not** a single centrally-operated service. There is no canonical
  "the" coordinator — see Federation Model.

## Build Scope

This design is specified as one integrated system: federation, desktop and
mobile clients, expert-sharded MoE inference, speculative decoding,
locality clustering, and the full safety/trust layer are all part of the
target, not a subset held back for a later release. There is no
feature-gated rollout plan in this document.

Two things are explicitly *not* covered by that statement, because they are
runtime behaviors of the system, not development phases:

- **Progressive model-catalog unlocking** (small models available
  immediately, larger models becoming available as real aggregate capacity
  grows) is a permanent product mechanic — see Model Catalog section — not
  a "phase 2 feature." It runs from day one.
- Turning a systems design into working software still requires an
  internal build order (a foundation layer has to exist before things are
  built on it). That sequencing is an implementation-plan concern, covered
  when this spec moves into planning — it is not a statement about which
  *features* ship or don't.

## Architecture Overview

```
   [Coordinator instance A]<---federation--->[Coordinator instance B]
       |            |                              |          |
   +---v--+    +----v---+                     +----v---+  +---v----+
   |Linux |    |Android |                      | macOS  |  | iOS    |
   |node  |<-->|node    |     ...federated...   | node   |  | client |
   |(full)|mesh|(full)  |                       |(full)  |  |(query/ |
   +------+    +--------+                       +--------+  | fgnd)  |
                                                             +--------+

   Each coordinator instance exposes:
     - API Gateway (chat app + developer API clients connect here)
     - Node registry + capacity tracking (local to the instance)
     - Model catalog gate (local capacity, extendable via federation)
     - Pipeline routing (prefers local/federated-partner nodes)
```

**Components:**

1. **Client apps** — chat UI, a small on-device model that answers simple
   queries instantly with no network involvement, and the
   participation module (opt-in on every platform; unrestricted on
   desktop/laptop, since there's no iOS-style background execution limit
   there). Platforms: Android, iOS, Linux, Windows, macOS.
2. **Coordinator instance** — self-hostable service (anyone can run one):
   tracks which of its registered nodes are online and their capabilities,
   computes which catalog models its local + federated capacity can serve,
   assembles inference pipelines, and enforces its own usage policy.
3. **Federation layer** — coordinator instances discover and peer with each
   other, similar to Mastodon/Matrix server federation. An instance with
   insufficient local capacity for a request can route part of the pipeline
   through a federated partner instance's nodes. Instances choose their own
   federation partners and can defederate from instances found to host
   abusive traffic — see Safety section.
4. **P2P networking layer** — WebRTC data channels between nodes once
   matched, with STUN for NAT traversal and TURN relay as fallback.
5. **Local mesh layer** — WiFi Direct / Multipeer Connectivity / local LAN
   discovery for devices physically near each other, forming a low-latency
   "fast tier" cluster — analogous to fast local interconnect in a real
   datacenter.
6. **API gateway** — the developer-facing REST/gRPC endpoint on each
   instance. The chat app is simply its first client, not a special case.

**Query flow:**

1. User submits a prompt (chat app or API), against a specific coordinator
   instance (their own, or one they've chosen to trust).
2. The on-device small model checks whether it can answer directly. If so,
   it does — no network round-trip.
3. Otherwise, the app calls its instance's API gateway. The coordinator
   assembles a pipeline of nodes hosting the required model's experts,
   preferring local-mesh clusters, then its own registered nodes, then
   federated-partner capacity.
4. A safety classifier screens the prompt at the instance's entry point,
   while it is still complete plaintext (see Safety section) — this is the
   only point in the pipeline where that's possible.
5. A small on-device draft model proposes several tokens ahead
   (speculative decoding); the pipeline verifies a batch of guesses per
   round-trip rather than one hop-chain per token.
6. Tokens stream back to the user as they're produced.
7. A sample of requests is spot-checked via redundant computation across an
   independently chosen alternate pipeline, to detect broken or malicious
   nodes.

## Model & Sharding Strategy

- **Shard by expert, not by layer**, for Mixture-of-Experts (MoE)
  open-weight models. MoE models activate only a small subset of "expert"
  sub-networks per token (e.g. top-2-of-8); sharding by expert means a
  token typically needs to reach only the 1-2 nodes hosting the active
  experts for that layer, not every shard in a chain. This is the core
  structural advantage over plain pipeline-parallel systems (e.g. Petals),
  which target dense models and touch every shard on every token.

  **Correction found during Plan 4's implementation (2026-08-15):** llama.cpp
  stores all of a layer's experts as one merged 3D tensor per projection
  (`blk.N.ffn_gate_exps`, `_down_exps`, `_up_exps`), computed via a single
  indexed matmul (`GGML_OP_MUL_MAT_ID`) — individual experts are not
  separate tensors, so there is no supported way to place expert *K* of
  layer *N* on one device and expert *J* of the same layer on another
  without patching llama.cpp's core graph-building code. That's out of
  scope: it means invasively modifying a widely-used, well-tested inference
  engine's matmul routing logic, which trades a small sharding-granularity
  win for real correctness risk in code every other plan depends on — not
  a trade worth making. What *is* achievable, and what Plan 4 actually
  builds: explicit **per-layer** placement of a layer's whole MoE block via
  `llama_model_params.tensor_buft_overrides`, giving deliberate,
  coordinator-controllable control (e.g. "layers 0-15 on node A, 16-31 on
  node B") in place of Plan 2's automatic free-memory-proportional split —
  finer-grained *control*, not finer-grained *sharding* than a layer.
- **Locality clustering**: the coordinator prefers assembling pipelines
  from devices on the same local mesh when the requester has nearby peers;
  internet/federated routing is used only between clusters, not within one.
- **Speculative decoding**: cuts the number of round-trips per generated
  token by verifying multiple speculative tokens per hop instead of one.
- **Throughput-oriented pipelining**: many concurrent users' requests are
  pipelined across the same nodes (micro-batching), so nodes stay busy and
  aggregate throughput stays high even though any single reply is slower
  than a cloud LLM.

Realistic target: on the order of a few tokens/sec streamed per reply once
the network has meaningful scale — usable, not instant.

## Model Catalog & Progressive Unlocking

Models are onboarded via a manifest describing: quantization format,
expert/layer shard map, tokenizer, minimum aggregate capacity required to
serve it at a usable token rate, and a baseline safety evaluation (see
Safety section — new model manifests must clear this before acceptance). A
coordinator instance continuously computes its available capacity (local
nodes plus what federated partners can contribute) and compares it against
each catalog model's requirements. A model is available only once real
capacity supports it — capacity gates availability, the network never
promises more than it can currently deliver.

Planned catalog progression (by increasing capacity requirement):

| Tier | Example model | Capacity requirement | Notes |
|------|---------------|-----------------------|-------|
| 0 | Small on-device model (~1-3B, quantized) | None — runs on a single device | Always available; used for the "simple query" fast path in the query flow above |
| 1 | Small open-weight model (~7-8B dense, e.g. Mistral-7B class) | Small (tens of nodes, or a handful of desktop-class nodes) | First model that benefits from sharding across a few devices |
| 2 | Mixtral 8x7B (MoE, ~47B total / ~13B active) | Medium (hundreds of nodes, or a smaller number of desktop-class nodes given their larger capacity) | First model where expert-sharding is the primary technique |
| 3 | Larger open-weight MoE (e.g. Mixtral 8x22B, DeepSeek-MoE class) | Large (thousands of phone-class nodes, or a proportionally smaller number of desktop-class nodes) | Unlocked as the network scales |

Exact thresholds are estimates to be calibrated against real measured
per-node throughput once the system is live; the tiering structure — start
small, unlock bigger models as capacity grows — is the fixed design
decision, and applies per-instance based on that instance's own
local-plus-federated capacity view.

Unlock milestones are shown in the app (e.g. "1,240 active nodes — Mixtral
8x22B unlocked on this instance"), giving network growth a visible,
non-monetary reward.

## Device Tiering

- **Desktop/laptop (Linux, Windows, macOS), opted in**: the backbone tier.
  No OS-enforced background execution limits, often on and connected for
  long stretches (home servers, always-on desktops), and substantially more
  RAM/compute than a phone. These nodes can host larger shards and act as
  stable pipeline anchors that phone nodes route through.
- **Android, opted in, charging + WiFi**: full nodes via a foreground
  service (Android requires a persistent notification for this, which
  doubles as visible, consensual disclosure to the user). Host model
  shards, act as pipeline hops.
- **iOS, or any device that hasn't opted into background contribution**:
  contributes only while the app is actively open (foreground), or is a
  query-only client. Either way, fully usable to ask questions —
  contribution is optional, not required to use the network.
- **Low-power/weak devices**: automatically assigned lighter roles
  (verification/spot-checks, small shards) by the coordinator rather than
  excluded outright.

## Federation Model

- Anyone can run a coordinator instance from the open-source codebase — no
  approval or central registry required to operate one.
- Instances discover and peer with each other (federation), similar in
  spirit to Mastodon/Matrix. A request can be routed partly through a
  federated partner's nodes when local capacity is insufficient.
- Each instance sets its own usage policy, moderation rules, and
  federation partners — it can choose not to federate with (defederate
  from) instances found to host abusive traffic. There is a shared,
  published baseline code-of-conduct instances are encouraged to adopt,
  and a public directory of instances that have adopted it, so users can
  choose instances with a policy they trust — but adoption isn't centrally
  enforceable, since there is no central authority to enforce it.
- Trade-off, stated plainly: federation means no single point of control or
  failure, matching the project's premise that crowd-contributed compute
  shouldn't depend on one company. It also means moderation, abuse
  handling, and capacity aggregation are genuinely harder distributed
  problems than they would be with one central coordinator. This design
  accepts that cost deliberately (see Safety section for how it's
  mitigated, not eliminated).

## Safety & Social Responsibility

Federation and "free, open access to powerful open-weight models" combine
into real risks that have to be designed for, not bolted on later. This
section is as load-bearing as the architecture itself.

**Content and usage safety**

- Because federation removes any single point where a completed request
  could be inspected, **safety classification happens at the entry point —
  the client or the instance's API gateway — while the prompt is still
  complete plaintext**, before it's decomposed and routed into the
  pipeline. Once sharded, no single node (or the coordinator) can
  reconstruct enough to moderate after the fact, so this is the only place
  in the system where it's actually possible.
- Each instance runs an open-weight safety classifier (e.g. Llama Guard or
  similar) as a mandatory pre-filter at its own entry point. This is
  enforceable per-instance even without central control, the same way a
  Mastodon instance moderates its own users.
- New models entering the catalog require a baseline safety evaluation as
  part of the manifest-review process (documented in Model Catalog), not
  just a license and shard map. Prefer instruction-tuned models with
  baseline safety alignment over raw base models.
- Instances can defederate from partners found to host abusive traffic or
  bad-actor nodes — a social/reputation mechanism for accountability that
  doesn't require central control (see Federation Model).
- Rate limiting and anti-automation controls at the instance level, to
  prevent the free tier from being industrialized for spam, scam content,
  or abuse campaigns.
- An abuse-reporting flow feeding back into classifier tuning and catalog
  policy, published per instance.

**Contributor (node operator) protection**

- Consent must be explicit and plain-language, never a default-on toggle
  or a buried ToS checkbox: what runs on the device, the fact that the
  operator cannot see or control what content is being generated through
  their device given the trust model, and how to fully and immediately
  opt out.
- Device-health protections: automatic pause on thermal throttling, low
  battery, low storage, or metered/expensive connections — off by default
  on mobile data specifically, since "free LLM access" that quietly costs
  a contributor real money or battery life in a lower-income region is a
  real harm, not a neutral trade. This is a genuine equity concern for a
  network that asks individuals to subsidize infrastructure costs that a
  company would otherwise bear directly.
- Honest disclosure of legal uncertainty: contributing a node processes
  fragments (activations), not reconstructable content, which reduces but
  does not eliminate legal ambiguity — closer to the still-unsettled
  debates around Tor relay/exit-node operator liability than to a
  guaranteed safe harbor. Real legal review is required before launch, not
  assumed.

**Governance**

- A lightweight, independent project-stewardship structure (e.g. a
  nonprofit foundation, matching the model used by Matrix.org or
  Mastodon's gGmbH) to hold the codebase/trademark, coordinate security
  disclosures, publish the baseline code-of-conduct, and act as a point of
  contact for researchers and law enforcement — since there is no single
  company that otherwise plays that role in a federated system.

**Technical security**

- Model manifests and client releases are cryptographically signed;
  reproducible builds where feasible. Nodes must be able to verify that
  what they're running actually matches the public, audited source — this
  matters more here than in most projects, since nodes execute code
  contributed by an open, federated project on personal hardware.
- Node-side execution is sandboxed to the minimum privilege needed
  (inference + networking only), to limit blast radius if a bug or a
  malicious manifest slips through review.
- Federation itself needs sybil-resistance at the instance level (not just
  the node level) — a malicious instance shouldn't be able to cheaply
  fabricate many "partner" identities to manipulate routing or reputation.

## Open Source Strategy

- Repository hosted on GitHub from the start, permissively licensed
  (Apache 2.0, matching the license of the initial target models). Covers
  client apps, coordinator, and the federation protocol itself.
- Open source is treated as a trust requirement, not just a growth
  mechanic: users are asked to run background compute from a stranger's
  code, and operators are asked to run federated infrastructure — both
  need to be able to verify what it does.
- Primary contribution surfaces for the community: new model manifests,
  platform-specific performance optimizations, coordinator/federation
  improvements, and safety-classifier tuning.

## Tech Stack

- **Shared native core**: given five target platforms (Android, iOS,
  Linux, Windows, macOS), the inference engine, networking, and federation
  protocol client live in a shared native core (C++, wrapping llama.cpp
  and libwebrtc) rather than being reimplemented per platform. Thin,
  platform-specific layers on top handle UI and OS integration (foreground
  services on Android, background-execution handling on iOS, native
  desktop UI on Linux/Windows/macOS).
- **Inference engine**: llama.cpp — mature, runs across all five target
  platforms, and GGUF already supports MoE architectures like Mixtral.
- **Networking**: WebRTC (libwebrtc) for P2P data channels plus STUN/TURN;
  gRPC or WebSocket for coordinator and federation communication.
- **Coordinator/instance backend**: a conventional, self-hostable service
  (Go or Node) — this layer is comparatively simple relative to the
  federation protocol design and the client-side inference/networking
  core, which carry the real engineering complexity.

## Known Risks

- **Scope**: this is a large build — a shared native inference/networking
  core across five platforms, a federation protocol, capacity-aware
  routing, MoE-aware sharding, per-instance safety infrastructure, and
  both a chat app and a developer API, specified as one integrated system
  rather than staged. Realistically a substantial, sustained engineering
  effort, not a short-term project — worth revisiting scope explicitly
  when this moves into an implementation plan.
- **Federated moderation is genuinely harder than centralized moderation**.
  The mitigations in the Safety section (entry-point classification,
  defederation, published baseline policy) reduce but do not eliminate the
  risk of bad-actor instances or nodes; this is an accepted, deliberate
  trade-off of the federation decision, not a solved problem.
- **Cold start**: the network is only as useful as current capacity
  allows; Tier 0/1 models need to be genuinely valuable on their own to
  attract the first contributors and instance operators before bigger
  models are reachable.
- **Latency ceiling**: even with every optimization in this design (expert
  sharding, locality clustering, speculative decoding, throughput
  pipelining), per-reply latency will remain meaningfully slower than
  centralized cloud inference. This is a permanent trade-off of the
  architecture, not a bug to be fixed later.
- **Prompt privacy**: unresolved at launch, as noted above. Positioning
  must not overclaim privacy guarantees the system doesn't yet provide.
- **Contributor equity**: without care, the burden of infrastructure cost
  (battery, device wear, data, electricity) shifts onto contributors who
  may be more price-sensitive than the beneficiaries of "free" access —
  mitigated but not eliminated by the device-health and consent controls
  in the Safety section.
