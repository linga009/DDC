import { randomUUID } from "node:crypto";
import type { NodeRegistry } from "./registry.ts";
import { stableNodeId } from "./registry.ts";
import type { ReputationTracker } from "./reputation_tracker.ts";
import type { ModelCatalog } from "./catalog.ts";
import type { LauncherInfo, LauncherRegistry } from "./launcher_registry.ts";
import type { PooledPipeline, PipelineTracker } from "./pipeline_tracker.ts";
import type { DemandTracker } from "./demand_tracker.ts";
import { selectPipeline } from "./pipeline_selector.ts";
import { canonicalizeEndpoint } from "./endpoint_identity.ts";

// Deliberately naive per the design doc's own explicit instruction not to
// over-engineer a scaling function without real load data: one pipeline
// per REQUESTS_PER_PIPELINE requests/minute of recent demand. A starting
// point, not a validated constant -- which is why it's a constructor
// parameter below rather than something a future tuner has to go editing
// module source to change.
const DEFAULT_REQUESTS_PER_PIPELINE = 10;
// Deliberately well under registry.ts's 30s node timeout, not equal to it.
// A launcher-spawned driver's registration is refreshed only by this loop's
// own heartbeat, so the gap between two consecutive ticks IS that driver's
// heartbeat period. At 30000 it exactly tied the 30s timeout -- and since
// setInterval only ever drifts late, the tie was lost in practice: a
// healthy, merely-idle pipeline was judged dead, torn down and respawned
// roughly every 60s with zero traffic. That is the precise opposite of what
// pre-warming exists to do, and strictly worse than Phase B, which kept its
// pipeline alive. The 3x headroom also buys tolerance for a tick or two
// SKIPPED by start()'s re-entrancy guard (which drops ticks while a slow
// launcher call is in flight); at 30000 a single dropped tick was fatal.
//
// It is NOT enough to survive a launcher that hangs: runOnce() awaits
// assemblies and teardowns sequentially with a 60s
// PIPELINE_ASSEMBLY_TIMEOUT_MS -- twice the node timeout -- and the driver
// heartbeat pre-pass sits inside that same serialized tick, so one
// unresponsive launcher can still starve an unrelated healthy model's
// driver of heartbeats until it ages out and its pipeline is torn down.
// Known and disclosed, not fixed here: the real fix is to decouple the
// heartbeat from the tick (or stop awaiting launcher I/O inside it).
export const DEFAULT_INTERVAL_MS = 10000;
const DEFAULT_IDLE_GRACE_MS = 300000;

const PIPELINE_ASSEMBLY_TIMEOUT_MS = 60000;

// One model's provisioning state for a single reconciliation tick -- the
// entire input the allocation decision below is allowed to look at.
export interface PoolDemandSnapshot {
  modelId: string;
  demand: number;
  currentCount: number;
  desiredCount: number;
}

// A decision, not an action: "this model should claim this launcher."
// Carrying it out (calling the launcher, registering the driver, adding a
// pool entry) is the caller's job.
export interface PipelineClaim {
  modelId: string;
  launcher: LauncherInfo;
}

// PURE. How many warm pipelines a model should have right now.
//
// - A model that doesn't need a multi-node pipeline at all (requiredNodeCount
//   <= 1) never engages this pool: it wants zero, always. This restates
//   Phase B's own guard so every caller of this function gets it for free.
// - Otherwise the count is ceil(demand / requestsPerPipeline), clamped to
//   [1, maxPipelines]: a model that needs a multi-node pipeline at all
//   always wants at least one warm, matching Phase B's "assemble on first
//   request" behavior as the floor, never zero. The floor deliberately
//   wins over a nonsensical maxPipelines < 1 (the design doc states the
//   at-least-one rule unconditionally for requiredNodeCount > 1 models).
export function desiredPipelineCount(
  demand: number,
  maxPipelines: number,
  requiredNodeCount: number,
  requestsPerPipeline: number,
): number {
  if (requiredNodeCount <= 1) {
    return 0;
  }
  const fromDemand = Math.ceil(demand / requestsPerPipeline);
  return Math.max(1, Math.min(fromDemand, maxPipelines));
}

// PURE. Given every model's current/desired counts and demand, which
// launchers are eligible for each, and which launchers are already spoken
// for, decide who claims what this tick.
//
// Two invariants this function exists to make independently checkable
// (the design doc's Testing Considerations calls this "the piece most
// likely to have a subtle off-by-one or ordering bug"):
//
//  1. NO PREEMPTION. A launcher in `claimedLauncherIds` -- i.e. one
//     already backing a live pool entry for this model or any other -- is
//     never handed to anyone, no matter how badly a busier model wants it.
//     It only becomes claimable once its own model's scale-down or health
//     check frees it, which happens before this runs, in the same tick.
//  2. NO DOUBLE-CLAIM. A launcher handed out here is immediately treated
//     as claimed for the rest of this tick, so two models can never be
//     planned onto the same one.
//
// Models are visited in descending demand order, and each is filled as far
// as its own deficit and the idle supply allow before the next is
// considered -- a launcher is a scarce, single-slot resource shared across
// the whole catalog, so the busiest model gets first refusal on it.
// `claimedLauncherIds` and `snapshots` are never mutated.
export function planAllocations(
  snapshots: PoolDemandSnapshot[],
  launchersForModel: (modelId: string) => LauncherInfo[],
  claimedLauncherIds: ReadonlySet<string>,
): PipelineClaim[] {
  const claimed = new Set(claimedLauncherIds);
  const claims: PipelineClaim[] = [];

  const underProvisioned = snapshots
    .filter(snapshot => snapshot.desiredCount > snapshot.currentCount)
    .sort((a, b) => b.demand - a.demand);

  for (const snapshot of underProvisioned) {
    let deficit = snapshot.desiredCount - snapshot.currentCount;
    for (const launcher of launchersForModel(snapshot.modelId)) {
      if (deficit <= 0) {
        break;
      }
      if (isLauncherClaimed(claimed, launcher)) {
        continue;
      }
      claimed.add(launcher.launcherId);
      claimed.add(launcher.identityKey); // keep this set's identity rule identical to isLauncherClaimed's
      claims.push({ modelId: snapshot.modelId, launcher });
      deficit--;
    }
  }

  return claims;
}

// PURE. Every launcherId currently backing a live pool entry, for any
// model the pool is tracked for -- i.e. every launcher that is NOT free
// to be claimed by anybody. A swarm-launcher supervises exactly one
// swarm-node-agent child at a time, for the whole catalog, so handing a
// claimed one to a second model doesn't add capacity: it silently kills
// the first model's agent, leaves that model's pool entry pointing at a
// machine now running different weights, and arms a later teardown of
// that entry to DELETE the new claimant's agent.
//
// `exclude` drops exactly one entry from the tally: the caller about to
// replace that specific dead entry with a fresh pipeline, which may
// legitimately re-use the very launcher the dead one was on.
//
// Exported (rather than inlined where it's used) because it has two
// callers that MUST agree on the answer: this module's own allocate()
// and server.ts's synchronous cold-start ensurePipelineReady(). Two
// independent copies of "which launchers are busy" is exactly how the
// background loop and the request path end up fighting over one machine.
export function claimedLauncherIds(
  catalog: ModelCatalog,
  pipelineTracker: PipelineTracker,
  exclude?: PooledPipeline,
): Set<string> {
  // Tallies BOTH the launcherId and the launcher's CANONICAL identity key
  // (endpoint_identity.ts's canonicalizeEndpoint(), stored per pool entry
  // as launcherIdentityKey -- Endpoint Identity Hardening). launcherId is
  // a randomUUID that LauncherRegistry re-mints whenever a lapsed
  // registration is re-registered (it refreshes in place only while
  // unexpired), so after any launcher restart or >timeoutMs heartbeat gap
  // the pool's stored id no longer matches the live one -- and the physical
  // machine stopped looking busy even though its agent was still running
  // and its pool entry still alive. Checking the identity key as well
  // survives that id rotation.
  //
  // Before Endpoint Identity Hardening this tallied the raw endpoint
  // STRING instead, which is not a canonical machine identity: one
  // physical launcher registered as both http://127.0.0.1:P and
  // http://localhost:P produced two live registry entries this tally
  // could not connect, so it could still be double-claimed -- live-
  // verified during Phase C's third review to serve a caller another
  // model's weights with a 200. The identity key collapses that alias
  // pair to one string; it is still a string, not a proof of possession,
  // so a DNS-name alias pointed at a different machine you don't control
  // is a separate, disclosed residual gap -- see README's Known gaming
  // vectors.
  const claimed = new Set<string>();
  for (const modelId of catalog.multiPipelineModelIds()) {
    for (const entry of pipelineTracker.getPool(modelId)) {
      if (entry === exclude) {
        continue;
      }
      claimed.add(entry.launcherId);
      if (entry.launcherIdentityKey) {
        claimed.add(entry.launcherIdentityKey);
      }
    }
  }
  return claimed;
}

// A launcher counts as claimed under either identity -- see
// claimedLauncherIds() for why the identity key has to be checked too.
export function isLauncherClaimed(claimed: Set<string>, launcher: LauncherInfo): boolean {
  return claimed.has(launcher.launcherId) || claimed.has(launcher.identityKey);
}

// The endpoint a launcher-spawned driver is reachable at: the launcher's
// own host, on its fixed --agent-port -- never anything from the pipeline
// selection that chose this launcher, since the driver isn't a
// pre-existing registered node, it's whatever fresh swarm-node-agent the
// launcher spawns in response to POST /pipeline.
//
// Exported (rather than inlined at each call site) because it has two
// callers that MUST agree on the exact string: this module's own
// tryAssemble() and server.ts's synchronous cold-start assemblePipeline().
// Before this existed, both files independently rebuilt the same
// concatenation -- exactly the kind of duplicated identity computation
// this project's own history (see CLAUDE.md's Phase C section) has three
// times let drift out of step between the background loop and the request
// path. One function that both sides call can't diverge.
export function launcherDriverEndpoint(launcher: LauncherInfo): string {
  const launcherUrl = new URL(launcher.endpoint);
  return `${launcherUrl.protocol}//${launcherUrl.hostname}:${launcher.agentPort}`;
}

// Thrown by assertDriverIdentityFree() below -- caught by each caller's
// existing try/catch (the same path a launcher fetch failure already
// takes), so a squatted driver identity fails this one assembly attempt
// loudly instead of silently registering the driver under the squatter's
// pinned endpoint.
export class DriverIdentityCollisionError extends Error {}

// A launcher-spawned driver's registration (registry.register(), called
// directly at each of this function's two call sites) bypasses POST
// /nodes/register's own collision-rejection check entirely -- there is no
// HTTP caller here to hand a 409 to. Without this, NodeRegistry.register()'s
// endpoint-pinning (see its own comment) has the OPPOSITE of its intended
// effect for this one caller: an unrelated, earlier, attacker-controlled
// registration that happens to collide with this driver's canonical
// identity keeps ITS pinned endpoint, and the coordinator then treats that
// attacker endpoint as the freshly-spawned driver -- live-verified (third
// whole-branch review) to hand a real user's prompt straight to the
// attacker with a 200, even though the launcher really did spawn an honest
// agent. driverEndpoint here is not a caller's unverified claim -- it's
// derived from an already-identity-verified LauncherRegistry entry, and
// POST /pipeline having just returned success means a real agent is
// listening there right now -- but that still doesn't license silently
// evicting whatever a third party has pinned. The same "reject, don't
// silently reassign" rule POST /nodes/register enforces applies here too:
// a squat just fails this one assembly attempt (disclosed residual, not a
// hijack) rather than registering over it or handing the driver's
// endpoint away.
//
// Call this synchronously, immediately before registry.register(), with
// no `await` in between -- mirrors POST /nodes/register's own re-check
// fix, for the same reason: no concurrent registration can land inside a
// gap that doesn't exist.
export function assertDriverIdentityFree(registry: NodeRegistry, driverIdentityKey: string, driverEndpoint: string): void {
  const pinnedEndpoint = registry.listActive().find(n => n.nodeId === stableNodeId(driverIdentityKey))?.endpoint;
  if (pinnedEndpoint !== undefined && pinnedEndpoint !== driverEndpoint) {
    throw new DriverIdentityCollisionError(
      `driver identity ${driverIdentityKey} is already registered under a different endpoint (${pinnedEndpoint}) -- refusing to let this pipeline assembly silently inherit it`);
  }
}

// Background reconciliation loop: keeps each multi-node model's pool of
// warm pipelines matched to recent demand, heals entries whose nodes have
// died or been reputation-ejected, and tears down pipelines nobody has
// used in a while so their launchers can serve some other model.
//
// Everything it decides is computed by the two pure functions above; this
// class is the part that talks to the network and mutates the trackers.
// Shared by this manager's own teardown and by server.ts's cold-start
// replacement path. Freeing a launcherId without calling this is the
// harmful case: the coordinator would mark the launcher reallocatable
// while its old agent is still running, holding both the agent port and
// the model's weights in RAM.
export async function stopLauncherPipeline(
  launcherRegistry: LauncherRegistry,
  launcherId: string,
  fallbackEndpoint?: string,
): Promise<void> {
  // A lapsed registration does NOT mean the agent stopped: LauncherRegistry
  // entries expire on their own heartbeat timeout, so without the recorded
  // endpoint as a fallback an expired launcher's agent was left running
  // while its launcherId was freed for reallocation.
  const endpoint = launcherRegistry.listActive().find(l => l.launcherId === launcherId)?.endpoint ?? fallbackEndpoint;
  if (!endpoint) {
    return; // never knew where it was -- nothing to call
  }
  try {
    // DELETE /pipeline is idempotent and always 204s, so calling it on a
    // launcher whose agent already exited is harmless.
    await fetch(`${endpoint}/pipeline`, {
      method: "DELETE",
      signal: AbortSignal.timeout(PIPELINE_ASSEMBLY_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`failed to stop pipeline on launcher ${endpoint}:`, err);
  }
}

export class PipelinePoolManager {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  // Fields are declared and assigned explicitly rather than via
  // constructor parameter properties: this coordinator runs TypeScript
  // directly under Node's strip-only mode (no build step, by deliberate
  // project-wide constraint), which rejects parameter properties outright
  // with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. Same style as registry.ts,
  // launcher_registry.ts and demand_tracker.ts.
  private readonly catalog: ModelCatalog;
  private readonly registry: NodeRegistry;
  private readonly reputation: ReputationTracker;
  private readonly launcherRegistry: LauncherRegistry;
  private readonly pipelineTracker: PipelineTracker;
  private readonly demandTracker: DemandTracker;
  private readonly random: () => number;
  private readonly intervalMs: number;
  private readonly idleGraceMs: number;
  private readonly requestsPerPipeline: number;

  constructor(
    catalog: ModelCatalog,
    registry: NodeRegistry,
    reputation: ReputationTracker,
    launcherRegistry: LauncherRegistry,
    pipelineTracker: PipelineTracker,
    demandTracker: DemandTracker,
    random: () => number = Math.random,
    intervalMs: number = DEFAULT_INTERVAL_MS,
    idleGraceMs: number = DEFAULT_IDLE_GRACE_MS,
    requestsPerPipeline: number = DEFAULT_REQUESTS_PER_PIPELINE,
  ) {
    this.catalog = catalog;
    this.registry = registry;
    this.reputation = reputation;
    this.launcherRegistry = launcherRegistry;
    this.pipelineTracker = pipelineTracker;
    this.demandTracker = demandTracker;
    this.random = random;
    this.intervalMs = intervalMs;
    this.idleGraceMs = idleGraceMs;
    this.requestsPerPipeline = requestsPerPipeline;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      // A tick that runs long (a launcher taking the full 60s assembly
      // timeout, say) must not overlap with the next one: two concurrent
      // passes would each see the same launcher as idle and both claim
      // it, breaking planAllocations' no-double-claim invariant from the
      // outside. Skipping a tick is always safe -- the next one re-derives
      // everything from scratch. runOnce() itself is deliberately left
      // unguarded so a direct call (tests, and any future explicit
      // "reconcile now") is never silently dropped.
      if (this.ticking) {
        return;
      }
      this.ticking = true;
      this.runOnce()
        .catch(err => console.warn("pipeline pool reconciliation failed:", err))
        .finally(() => {
          this.ticking = false;
        });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async runOnce(): Promise<void> {
    const modelIds = this.catalog.multiPipelineModelIds();
    if (modelIds.length === 0) {
      return;
    }
    await this.healthCheckAndScaleDown(modelIds);
    await this.allocate(modelIds);
  }

  // Step 1+2: drop any pool entry that is broken (a node no longer active,
  // or already marked failed by /generate's own forwarding path) and any
  // entry idle past the grace period. Both free their launcherId for
  // reallocation below, in the SAME tick they're freed -- allocate()
  // re-derives claimed state fresh from the tracker after this runs.
  private async healthCheckAndScaleDown(modelIds: string[]): Promise<void> {
    // Heartbeat every pooled driver BEFORE the listActive() snapshot below,
    // rather than once per entry at the bottom of the loop. A
    // launcher-spawned driver never self-heartbeats -- nothing external
    // pings it -- so this call is the only thing keeping it in the registry.
    //
    // Ordering alone is NOT what makes this correct, and it is worth being
    // precise about why: registry.heartbeat() refuses to revive a node that
    // is already past timeoutMs (see registry.ts -- "a node past its timeout
    // cannot be revived by a heartbeat"), so once the gap between two ticks
    // exceeds the timeout, no placement of this call can save the driver.
    // The load-bearing fix is DEFAULT_INTERVAL_MS being comfortably UNDER
    // registry.ts's timeout; see the constant's own comment.
    //
    // What hoisting buys on top of that is a tick's own duration: tearDown()
    // and tryAssemble() below each await real HTTP calls with 60s timeouts,
    // so a slow launcher could otherwise let a healthy driver age out
    // between the snapshot at the top and a heartbeat at the bottom of the
    // very same tick.
    for (const modelId of modelIds) {
      for (const entry of this.pipelineTracker.getPool(modelId)) {
        if (entry.state === "assembling") {
          continue; // a reservation held by an in-flight tryAssemble: no driver exists yet
        }
        // Only the driver: compute contributors are real registered nodes
        // that ping for themselves, and pinging them here would mask their
        // death instead of detecting it.
        this.registry.heartbeat(entry.driverNodeId);
      }
    }

    const activeNodeIds = new Set(this.registry.listActive(this.reputation).map(n => n.nodeId));
    const now = Date.now();

    for (const modelId of modelIds) {
      // Copy: tearDown() splices the very array getPool() hands back.
      for (const entry of [...this.pipelineTracker.getPool(modelId)]) {
        if (entry.state === "assembling") {
          // An in-flight tryAssemble owns this reservation and removes it
          // itself on success or failure. Its driver does not exist yet, so
          // every liveness check below would judge it dead and tear down a
          // pipeline that is still being built.
          continue;
        }
        const allNodesActive = [entry.driverNodeId, ...entry.computeNodeIds].every(id => activeNodeIds.has(id));
        if (!allNodesActive) {
          // A heartbeat timeout or a reputation ejection anywhere in the
          // pipeline. This is what turns that into a background-healed
          // condition instead of the next request discovering a 502.
          await this.tearDown(modelId, entry);
          continue;
        }
        if (entry.state === "failed") {
          // /generate marks an entry failed when a forward to its driver
          // fails. The driver is usually still "active" by registration
          // timestamp at that point (listActive() reflects registration
          // recency, never liveness), so the node check above would never
          // reap it and its launcher would stay claimed forever.
          await this.tearDown(modelId, entry);
          continue;
        }
        if (entry.state === "warm" && now - entry.lastUsedAt > this.idleGraceMs) {
          await this.tearDown(modelId, entry);
          continue;
        }

        // The driver was already heartbeated in the pre-pass above. Like
        // that pre-pass, it is unconditional on liveness, so a driver whose
        // process actually died stays "active" here. Two things bound that:
        // /generate marks the entry failed the moment a forward to it fails
        // (reaped above, next tick), and with no traffic at all the idle
        // grace period tears it down anyway.
      }
    }
  }

  private async tearDown(modelId: string, entry: PooledPipeline): Promise<void> {
    await this.tryStopLauncher(entry.launcherId, entry.launcherEndpoint);
    this.pipelineTracker.removeEntry(modelId, entry.pipelineId);
  }

  private async tryStopLauncher(launcherId: string, fallbackEndpoint?: string): Promise<void> {
    await stopLauncherPipeline(this.launcherRegistry, launcherId, fallbackEndpoint);
  }

  // Step 3+4: compute every model's desired count, decide the claims
  // (purely), then carry them out in the order decided.
  private async allocate(modelIds: string[]): Promise<void> {
    const snapshots: PoolDemandSnapshot[] = modelIds.map(modelId => {
      // One read per model per tick: recentDemand() prunes its window in
      // place as a side effect of being read, so calling it twice for the
      // same model is both wasteful and a way for the demand figure the
      // sort uses to disagree with the one the desired count came from.
      const demand = this.demandTracker.recentDemand(modelId);
      return {
        modelId,
        demand,
        currentCount: this.pipelineTracker.getPool(modelId).length,
        desiredCount: desiredPipelineCount(
          demand,
          this.catalog.maxPipelines(modelId),
          this.catalog.requiredNodeCount(modelId),
          this.requestsPerPipeline,
        ),
      };
    });

    // Claimed = the launcherId of any pool entry for any model, read fresh
    // after the health check above has already freed whatever it freed.
    // Nothing is excluded: every entry standing at this point is live.
    const claims = planAllocations(
      snapshots,
      modelId => this.launcherRegistry.listForModel(modelId),
      claimedLauncherIds(this.catalog, this.pipelineTracker),
    );

    // A model whose assembly fails is dropped for the rest of this tick
    // rather than retried against the next launcher -- if the swarm is
    // short of nodes, or this model's spawns are failing, hammering every
    // remaining launcher with the same doomed request just wastes a whole
    // reconciliation interval. The next tick re-derives everything.
    const failedModelIds = new Set<string>();
    for (const claim of claims) {
      if (failedModelIds.has(claim.modelId)) {
        continue;
      }
      const assembled = await this.tryAssemble(claim.modelId, claim.launcher);
      if (!assembled) {
        failedModelIds.add(claim.modelId);
      }
    }
  }

  // Mirrors ensurePipelineReady()'s launcher call in server.ts exactly --
  // same request shape, same driver-endpoint derivation, same "never
  // throws, just returns false" contract. No Authorization header: a
  // swarm-launcher binds 127.0.0.1 only and checks no bearer token, by
  // explicit design (its trust is structural, inherited from the bind).
  private async tryAssemble(modelId: string, launcher: LauncherInfo): Promise<boolean> {
    const requiredNodeCount = this.catalog.requiredNodeCount(modelId);
    // A readiness gate, not a reservation: selectPipeline returns
    // undefined unless the swarm already has requiredNodeCount active,
    // trusted candidates, in which case spawning a driver isn't worth it
    // yet. selection.driver is deliberately unused -- the driver is the
    // brand-new agent the launcher spawns, reachable at the launcher's own
    // host and registered agentPort; only computeContributors feeds the
    // --remote list.
    const selection = selectPipeline(this.registry.listActive(this.reputation), this.reputation, requiredNodeCount, this.random);
    if (!selection) {
      return false;
    }

    // A launcher-spawned driver's endpoint is fully determined by the
    // launcher (its own host plus its fixed agentPort), and nodeId is
    // derived from that endpoint's CANONICAL identity key -- so a driver
    // that has been reputation-ejected inherits the ejection on every
    // respawn, forever, even across a launcher restart or an alias change.
    // Without this check the loop was unbreakable: assemble (the POST
    // succeeds), next tick's health check sees the driver missing from
    // listActive(reputation) and tears it down, allocate re-claims the same
    // launcher, repeat -- one real multi-GB model load and kill every tick,
    // plus one more per /generate, none of which can ever succeed.
    //
    // Computed once here and reused below at actual registration time
    // (rather than recomputed) -- both the preflight check and the real
    // registration MUST agree on this driver's identity, and canonicalizing
    // it twice would also mean two DNS lookups per assembly attempt for no
    // benefit.
    const driverEndpoint = launcherDriverEndpoint(launcher);
    const driverIdentityKey = await canonicalizeEndpoint(driverEndpoint);
    const prospectiveDriverId = stableNodeId(driverIdentityKey);
    if (!this.reputation.isTrusted(prospectiveDriverId)) {
      console.warn(`skipping launcher ${launcher.endpoint} for model ${modelId}: the driver it would spawn is reputation-ejected`);
      return false;
    }

    // Reserve the launcher BEFORE the network call, not after it. addEntry
    // used to run only once POST /pipeline had returned, so for the whole
    // assembly window this launcher was invisible to claimedLauncherIds()
    // -- and a concurrent cold-start /generate for a DIFFERENT model would
    // read it as idle and claim it too. That is exactly the corruption
    // claimedLauncherIds() exists to prevent: a swarm-launcher supervises
    // one agent at a time, so both models end up with a "warm" entry
    // pointing at one agent serving only the later model's weights, and
    // tearing down either entry kills the other's agent. The reservation
    // uses the "assembling" state, which every consumer already knows to
    // skip: it has no driver yet, so it is never routed to, never
    // heartbeated and never health-checked.
    // Re-check at the moment of commitment, not just when the plan was
    // built. planAllocations() is pure and internally consistent, but
    // allocate() consumes its plan across `await tryAssemble(...)`
    // boundaries -- a real model load holds the first claim's fetch open
    // for seconds -- and in that window the REQUEST path can legitimately
    // claim a launcher this plan had earmarked for a later entry. Without
    // this the later claim reserved it anyway, and one launcher ended up
    // backing two models: same launcherId, same driverNodeId, and a user
    // asking for one model served the other's weights with a 200.
    //
    // This is the rule the two reservations above only half-express:
    // nothing may commit to a launcher without confirming it is STILL free
    // at commit time. assemblePipeline() in server.ts needs no equivalent
    // because it picks and reserves with no await in between.
    if (isLauncherClaimed(claimedLauncherIds(this.catalog, this.pipelineTracker), launcher)) {
      return false; // the plan went stale; the next tick re-derives it
    }

    const reservationId = randomUUID();
    this.pipelineTracker.addEntry(modelId, {
      pipelineId: reservationId,
      driverNodeId: "",
      computeNodeIds: [],
      launcherId: launcher.launcherId,
      launcherEndpoint: launcher.endpoint,
      launcherIdentityKey: launcher.identityKey,
      state: "assembling",
      lastUsedAt: Date.now(),
    });

    try {
      // swarm-node-agent's --remote takes host:port, not a full URL.
      const toHostPort = (endpoint: string) => endpoint.replace(/^https?:\/\//, "");
      const remoteEndpoints = selection.computeContributors.map(n => toHostPort(n.endpoint)).join(",");
      // Empty layer placements: InferenceEngine's automatic placement
      // takes over, exactly as it already does for every manually
      // configured multi-node pipeline and for Phase B's own assembly.
      const res = await fetch(`${launcher.endpoint}/pipeline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: modelId, remoteEndpoints, layerPlacements: "" }),
        signal: AbortSignal.timeout(PIPELINE_ASSEMBLY_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.pipelineTracker.removeEntry(modelId, reservationId);
        return false;
      }

      // driverEndpoint/driverIdentityKey were already computed above for
      // the preflight trust check -- reused here, not rebuilt, so this
      // registration can never derive a different identity than the one
      // that was actually checked.
      assertDriverIdentityFree(this.registry, driverIdentityKey, driverEndpoint);
      const driverNodeId = this.registry.register(driverEndpoint, driverIdentityKey, "desktop", undefined, modelId);
      // Swap the reservation for the real entry: same launcher, so the
      // claim is continuous and never briefly drops.
      this.pipelineTracker.removeEntry(modelId, reservationId);
      this.pipelineTracker.addEntry(modelId, {
        pipelineId: randomUUID(),
        driverNodeId,
        computeNodeIds: selection.computeContributors.map(n => n.nodeId),
        launcherId: launcher.launcherId,
        launcherEndpoint: launcher.endpoint,
        launcherIdentityKey: launcher.identityKey,
        state: "warm",
        // Wall-clock Date.now(), never an injected clock: server.ts's
        // /generate path stamps this same field with a raw Date.now() when
        // it uses a pool entry, and the idle check in
        // healthCheckAndScaleDown compares against Date.now() too. All
        // three have to share one epoch or the grace period means nothing.
        lastUsedAt: Date.now(),
      });
      return true;
    } catch (err) {
      console.warn(`failed to assemble pipeline for model ${modelId} via launcher ${launcher.endpoint}:`, err);
      this.pipelineTracker.removeEntry(modelId, reservationId);
      if (err instanceof DriverIdentityCollisionError) {
        // Fourth whole-branch review, Important finding, fixed here --
        // same reasoning as server.ts's assemblePipeline() catch block:
        // assertDriverIdentityFree() only throws after POST /pipeline
        // already returned success, so refusing the registration must not
        // orphan the real agent the launcher just spawned.
        await stopLauncherPipeline(this.launcherRegistry, launcher.launcherId, launcher.endpoint);
      }
      return false;
    }
  }
}
