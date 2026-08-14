# Distributed Inference Network for Open-Weight LLMs on Mobile

**Status:** Draft — approved by user, pending final review
**Date:** 2026-08-14

## Summary

A mobile app (Android + iOS) and open-source network that pools idle phone
compute so people can run open-weight LLMs too large for any single phone,
for free, with no donation/token/incentive economy. Contribution is
reciprocal by design: your phone helps host model shards, and in exchange
you (and everyone else) get access to models the network can collectively
serve. The set of models available grows automatically as the swarm grows —
small models run from day one; bigger models unlock once the network has
enough real aggregate capacity to serve them.

The project is open source from the start. Asking people to let an app use
their phone's compute in the background requires them to be able to verify
it isn't doing anything malicious — closed source is a trust blocker for
this specific product.

## Goals

- Serve inference for open-weight LLMs (starting small, scaling up) using
  pooled compute from volunteer Android and iOS phones, reachable over the
  internet (not limited to a single local network).
- Ship both a consumer chat app and a developer-facing API on the same
  backend.
- Model catalog is pluggable: new open-weight models can be onboarded via a
  manifest, without redesigning the system.
- No cryptocurrency, token, or donation-based incentive layer. Participation
  is reciprocal (you contribute capacity, you get access), not transactional.
- Open source, permissively licensed, built to accept community
  contributions (new model manifests, platform optimizations, coordinator
  improvements).

## Non-Goals

- **Not** targeting cloud-LLM response speed. Per-reply latency will be
  noticeably slower than ChatGPT/Claude/etc. The product is honest about
  this trade-off: bigger open models than any single phone could run, for
  free, in exchange for patience.
- **Not** building a decentralized storage network. Phone storage is not a
  core pillar — phones are unreliable as durable storage nodes (OS kills
  background apps, limited free space, constantly changing networks). If
  storage-like needs arise (e.g. caching shared knowledge-base chunks),
  that's a narrow, deferred feature, not core infrastructure.
- **Not** promising strong prompt privacy in v1. Prompts pass through
  intermediate strangers' phones as activations, not raw text — but
  activation-inversion attacks are an active research area and unsolved
  here. This is disclosed to users, not glossed over.
- **Not** attempting full swarm-node parity between iOS and Android. iOS's
  background execution restrictions mean iOS devices are foreground/query
  clients, not always-on pipeline hosts, at least in v1.

## Architecture Overview

```
                     +----------------------+
   Chat app  ------> |                      |
                     |     API Gateway      | <------ 3rd-party developers
   (Android/iOS) --> |                      |
                     +----------+-----------+
                                |
                     +----------v-----------+
                     |   Coordinator        |
                     |  - node registry      |
                     |  - capacity tracking  |
                     |  - model catalog gate |
                     |  - pipeline routing   |
                     +----------+-----------+
                                |
              +-----------------+------------------+
              |                 |                   |
        +-----v----+      +-----v----+        +-----v----+
        | Android  |      | Android  |        |  iOS     |
        | full node|<---->| full node|        | client   |
        | (WebRTC/ |local | (WebRTC/ |        | (query-  |
        |  mesh)   |mesh  |  mesh)   |        |  only or |
        +----------+      +----------+        |  fgnd)   |
                                               +----------+
```

**Components:**

1. **Client app** (Android + iOS) — chat UI, a small on-device model that
   answers simple queries instantly with no swarm involvement, and the
   swarm-participation module (Android only, opt-in).
2. **Coordinator service** — tracks which nodes are online, their
   capabilities (device tier, network locality, battery/charging state),
   which models the current swarm capacity can serve, and assembles
   inference pipelines per request.
3. **P2P networking layer** — WebRTC data channels between phones once
   matched by the coordinator, with STUN for NAT traversal and TURN relay
   as fallback for phones behind symmetric NAT or on cellular.
4. **Local mesh layer** — WiFi Direct (Android) / Multipeer Connectivity
   (iOS, foreground only) for phones physically near each other, forming a
   low-latency "fast tier" cluster, analogous to fast local interconnect in
   a real datacenter.
5. **API gateway** — the developer-facing REST/gRPC endpoint. The chat app
   is simply its first client, not a special case.

**Query flow:**

1. User submits a prompt (chat app or API).
2. The on-device small model checks whether it can answer directly. If so,
   it does — no swarm round-trip.
3. Otherwise, the app calls the API gateway, which asks the coordinator for
   a pipeline of nodes currently hosting the required model's experts,
   preferring physically-local clusters when available.
4. A small on-device draft model proposes several tokens ahead
   (speculative decoding); the swarm pipeline verifies a batch of guesses
   per round-trip rather than one hop-chain per token.
5. Tokens stream back to the user as they're produced.
6. A sample of requests is spot-checked via redundant computation across an
   independently chosen alternate pipeline, to detect broken or malicious
   nodes.

## Model & Sharding Strategy

- **Shard by expert, not by layer**, for Mixture-of-Experts (MoE)
  open-weight models. MoE models activate only a small subset of "expert"
  sub-networks per token (e.g. top-2-of-8); sharding by expert means a
  token typically needs to reach only the 1-2 phones hosting the active
  experts for that layer, not every phone in a chain. This is the core
  structural advantage over plain pipeline-parallel systems (e.g. Petals),
  which target dense models and touch every shard on every token.
- **Locality clustering**: the coordinator prefers assembling pipelines
  from phones on the same local mesh (WiFi Direct/Multipeer) when the
  requester has nearby peers; internet relay is used only between clusters,
  not within one.
- **Speculative decoding**: cuts the number of round-trips per generated
  token by verifying multiple speculative tokens per hop instead of one.
- **Throughput-oriented pipelining**: many concurrent users' requests are
  pipelined across the same nodes (micro-batching), so nodes stay busy and
  aggregate swarm throughput stays high even though any single reply is
  slower than a cloud LLM.

Realistic target: on the order of a few tokens/sec streamed per reply once
the swarm has meaningful scale — usable, not instant.

## Model Catalog & Progressive Unlocking

Models are onboarded via a manifest describing: quantization format,
expert/layer shard map, tokenizer, and the minimum aggregate swarm capacity
required to serve it at a usable token rate. The coordinator continuously
computes current aggregate swarm capacity (active full nodes × device tier)
and compares it against each catalog model's requirements. A model is
available in the app only once real capacity supports it — capacity gates
availability, the network never promises more than it can currently
deliver.

Planned catalog progression (by increasing swarm-capacity requirement):

| Tier | Example model | Swarm requirement | Notes |
|------|---------------|--------------------|-------|
| 0 | Small on-device model (~1-3B, quantized) | None — runs on a single phone | Always available; used for the "simple query" fast path in the query flow above |
| 1 | Small open-weight model (~7-8B dense, e.g. Mistral-7B class) | Small swarm (tens of nodes) | First model that benefits from sharding across a few phones |
| 2 | Mixtral 8x7B (MoE, ~47B total / ~13B active) | Medium swarm (hundreds of nodes) | First model where expert-sharding is the primary technique |
| 3 | Larger open-weight MoE (e.g. Mixtral 8x22B, DeepSeek-MoE class) | Large swarm (thousands of nodes) | Unlocked as the network scales |

The exact node-count thresholds are estimates to be calibrated against real
measured per-node throughput once Phase 1 is running (see Roadmap); the
tiering structure itself — start small, unlock bigger models as capacity
grows — is the fixed design decision.

Unlock milestones are shown in the app (e.g. "1,240 active nodes — Mixtral
8x22B unlocked"), giving swarm growth a visible, non-monetary reward.

## Device Tiering

- **Android, opted in, charging + WiFi**: full nodes. Run as a foreground
  service (Android requires a persistent notification for this, which
  doubles as visible, consensual disclosure to the user). Host model
  shards, act as pipeline hops.
- **iOS, or any Android device that hasn't opted into background
  contribution**: contributes only while the app is actively open
  (foreground), or is a query-only client. Either way, fully usable to ask
  questions — contribution is optional, not required to use the network.
- **Low-power/weak devices**: automatically assigned lighter roles
  (verification/spot-checks, small shards) by the coordinator rather than
  excluded outright.

## Trust & Security

- **Bad or malicious nodes**: per-node reputation scoring based on
  agreement with redundant spot-checks; nodes that consistently deviate
  from independently-verified results are automatically ejected from
  routing.
- **Prompt privacy through intermediate nodes**: disclosed as a known,
  unsolved limitation in v1 rather than overclaimed. Intermediate nodes see
  activations, not raw prompt text, but activation-inversion research shows
  this isn't a complete privacy guarantee. Future work may restrict
  sensitive queries to vetted-only node sets or explore partial encryption
  schemes; neither is in scope for v1.
- **Battery/data abuse**: contribution is strictly opt-in, with visible
  user controls — contribute only while charging, on WiFi, and above a
  user-configurable battery threshold.

## Open Source Strategy

- Repository hosted on GitHub from the start, permissively licensed
  (Apache 2.0, matching the license of the initial target models).
- Open source is treated as a trust requirement, not just a growth
  mechanic: users are asked to run background compute contributed by a
  stranger's code, and need to be able to verify what it does.
- Primary contribution surfaces for the community: new model manifests
  (onboarding additional open-weight models into the catalog), platform-
  specific performance optimizations, and coordinator improvements.

## Tech Stack

- **Mobile**: native Kotlin (Android) and Swift (iOS) for the
  inference/networking core, since it needs direct access to NPU/GPU and
  (on Android) foreground services. A shared cross-platform UI shell is an
  option on top, but inference and networking stay native.
- **Inference engine**: llama.cpp — mature, ARM-optimized, and GGUF already
  supports MoE architectures like Mixtral.
- **Networking**: WebRTC (libwebrtc) for P2P data channels plus STUN/TURN;
  gRPC or WebSocket for coordinator communication.
- **Coordinator/backend**: a conventional service (Go or Node); this layer
  is comparatively simple — the hard engineering is in the client-side
  inference and networking logic, not the backend.

## Roadmap

- **Phase 1**: Android full nodes + iOS query-only clients; server-relayed
  routing (no direct P2P yet, to keep the trust/debugging surface simple);
  Tier 0 and Tier 1 catalog models; chat app; basic node health monitoring;
  opt-in contribution controls. Goal: calibrate real per-node throughput
  numbers to set accurate Tier 2/3 capacity thresholds.
- **Phase 2**: direct P2P (WebRTC) between matched nodes, local mesh
  clustering (WiFi Direct/Multipeer), speculative decoding, reputation-
  based routing, public developer API, Tier 2 catalog unlock (Mixtral
  8x7B).
- **Phase 3**: Tier 3+ catalog models, iOS background-contribution
  research, stronger privacy mitigations for prompts in transit.

## Known Risks

- **Scope**: this is a large build even at Phase 1 — native mobile
  inference engine integration, P2P/relay networking, a coordinator with
  capacity-aware routing, MoE-aware sharding, and a chat app, before a
  single active user exists. Realistically a small dedicated team across
  multiple quarters, not a solo short-term project.
- **Cold start**: the network is only as useful as its current node count
  allows; Tier 0/1 need to be genuinely valuable on their own to attract
  the first contributors before bigger models are reachable.
- **Latency ceiling**: even with every optimization in this design (expert
  sharding, locality clustering, speculative decoding, throughput
  pipelining), per-reply latency will remain meaningfully slower than
  centralized cloud inference. This is a permanent trade-off of the
  architecture, not a bug to be fixed later.
- **Prompt privacy**: unresolved in v1, as noted above. Marketing/positioning
  must not overclaim privacy guarantees the system doesn't yet provide.
