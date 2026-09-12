import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { DEFAULT_INTERVAL_MS, PipelinePoolManager, claimedLauncherIds, desiredPipelineCount, isLauncherClaimed, planAllocations } from "../src/pipeline_pool_manager.ts";
import { PipelineTracker } from "../src/pipeline_tracker.ts";
import { DemandTracker } from "../src/demand_tracker.ts";
import { LauncherRegistry, type LauncherInfo } from "../src/launcher_registry.ts";
import { NodeRegistry, stableNodeId } from "../src/registry.ts";
import { ReputationTracker } from "../src/reputation_tracker.ts";
import { ModelCatalog } from "../src/catalog.ts";

// A minimal stand-in for a swarm-launcher's HTTP interface: responds to
// POST /pipeline with a canned success body and counts calls; responds to
// DELETE /pipeline by counting the call and returning 204. Mirrors
// coordinator/tests/server.test.ts's own startStubNodeAgent pattern.
async function startStubLauncher() {
  let pipelineCalls = 0;
  let deleteCalls = 0;
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.method === "DELETE") {
      deleteCalls++;
      res.writeHead(204);
      res.end();
      return;
    }
    pipelineCalls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ready" }));
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected stub launcher to bind to a port");
  }
  return {
    server,
    endpoint: `http://127.0.0.1:${address.port}`,
    port: address.port as number,
    getPipelineCalls: () => pipelineCalls,
    getDeleteCalls: () => deleteCalls,
  };
}

function makeManager(overrides: {
  catalog?: ModelCatalog;
  registry?: NodeRegistry;
  reputation?: ReputationTracker;
  launcherRegistry?: LauncherRegistry;
  pipelineTracker?: PipelineTracker;
  demandTracker?: DemandTracker;
  random?: () => number;
  idleGraceMs?: number;
  requestsPerPipeline?: number;
}) {
  return new PipelinePoolManager(
    overrides.catalog ?? new ModelCatalog([]),
    overrides.registry ?? new NodeRegistry(),
    overrides.reputation ?? new ReputationTracker(),
    overrides.launcherRegistry ?? new LauncherRegistry(),
    overrides.pipelineTracker ?? new PipelineTracker(),
    overrides.demandTracker ?? new DemandTracker(),
    overrides.random ?? Math.random,
    30000, // intervalMs -- irrelevant for direct runOnce() calls
    overrides.idleGraceMs ?? 300000, // 5 minutes
    overrides.requestsPerPipeline ?? 10,
  );
}

function launcherFixture(launcherId: string, servesModels: string[]): LauncherInfo {
  return { launcherId, endpoint: `http://127.0.0.1:9/${launcherId}`, servesModels, agentPort: 9000 };
}

// ---------------------------------------------------------------------------
// The two pure decision functions the design doc's Testing Considerations
// asks for by name -- inspectable with no network, no timers, no registries.
// ---------------------------------------------------------------------------

test("desiredPipelineCount is zero for a model that needs only one node", () => {
  assert.equal(desiredPipelineCount(999, 4, 1, 10), 0);
  assert.equal(desiredPipelineCount(0, 4, 1, 10), 0);
});

test("desiredPipelineCount floors at one warm pipeline even with zero demand", () => {
  assert.equal(desiredPipelineCount(0, 4, 2, 10), 1);
  assert.equal(desiredPipelineCount(1, 4, 2, 10), 1);
  assert.equal(desiredPipelineCount(10, 4, 2, 10), 1);
});

test("desiredPipelineCount grows one pipeline per requestsPerPipeline of demand", () => {
  assert.equal(desiredPipelineCount(11, 4, 2, 10), 2);
  assert.equal(desiredPipelineCount(20, 4, 2, 10), 2);
  assert.equal(desiredPipelineCount(21, 4, 2, 10), 3);
  // requestsPerPipeline is a real tunable, not a baked-in 10.
  assert.equal(desiredPipelineCount(6, 4, 2, 5), 2);
});

test("desiredPipelineCount never exceeds the catalog's maxPipelines cap", () => {
  assert.equal(desiredPipelineCount(1000, 2, 2, 10), 2);
  assert.equal(desiredPipelineCount(1000, 1, 2, 10), 1);
});

test("planAllocations gives a single contested launcher to the higher-demand model and never double-claims it", () => {
  const launcher = launcherFixture("L1", ["low", "high"]);
  const claims = planAllocations(
    [
      { modelId: "low", demand: 1, currentCount: 0, desiredCount: 1 },
      { modelId: "high", demand: 9, currentCount: 0, desiredCount: 1 },
    ],
    () => [launcher],
    new Set(),
  );
  assert.deepEqual(claims.map(c => ({ modelId: c.modelId, launcherId: c.launcher.launcherId })), [
    { modelId: "high", launcherId: "L1" },
  ]);
});

test("planAllocations never claims a launcher already backing a live pipeline", () => {
  const claims = planAllocations(
    [{ modelId: "a", demand: 50, currentCount: 0, desiredCount: 1 }],
    () => [launcherFixture("L1", ["a"])],
    new Set(["L1"]),
  );
  assert.deepEqual(claims, []);
});

test("planAllocations claims one launcher per missing pipeline, up to the model's deficit", () => {
  const launchers = [launcherFixture("L1", ["a"]), launcherFixture("L2", ["a"]), launcherFixture("L3", ["a"])];
  const claims = planAllocations(
    [{ modelId: "a", demand: 30, currentCount: 1, desiredCount: 3 }],
    () => launchers,
    new Set(),
  );
  assert.deepEqual(claims.map(c => c.launcher.launcherId), ["L1", "L2"]);
});

test("planAllocations skips models that already have their desired count and does not mutate its inputs", () => {
  const claimed = new Set(["L9"]);
  const snapshots = [
    { modelId: "satisfied", demand: 100, currentCount: 2, desiredCount: 2 },
    { modelId: "hungry", demand: 1, currentCount: 0, desiredCount: 1 },
  ];
  const claims = planAllocations(snapshots, () => [launcherFixture("L1", ["satisfied", "hungry"])], claimed);
  assert.deepEqual(claims.map(c => c.modelId), ["hungry"]);
  assert.deepEqual([...claimed], ["L9"]);
  assert.deepEqual(snapshots.map(s => s.currentCount), [2, 0]);
});

// ---------------------------------------------------------------------------
// The reconciliation loop itself.
// ---------------------------------------------------------------------------

test("runOnce assembles a fresh pipeline for a model with demand, an idle launcher, and enough active nodes", async () => {
  const launcherStub = await startStubLauncher();
  try {
    const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 2 }]);
    const registry = new NodeRegistry();
    registry.register("http://127.0.0.1:1", "desktop");
    registry.register("http://127.0.0.1:2", "desktop");
    const launcherRegistry = new LauncherRegistry();
    launcherRegistry.register(launcherStub.endpoint, ["big-model"], launcherStub.port);
    const demandTracker = new DemandTracker();
    demandTracker.recordRequest("big-model");
    const pipelineTracker = new PipelineTracker();

    const manager = makeManager({ catalog, registry, launcherRegistry, demandTracker, pipelineTracker });
    await manager.runOnce();

    assert.equal(launcherStub.getPipelineCalls(), 1);
    assert.equal(pipelineTracker.getPool("big-model").length, 1);
    assert.equal(pipelineTracker.getPool("big-model")[0].state, "warm");
  } finally {
    launcherStub.server.close();
  }
});

test("runOnce does nothing for a model with requiredNodeCount 1", async () => {
  const launcherStub = await startStubLauncher();
  try {
    const catalog = new ModelCatalog([{ id: "small-model", displayName: "Small", minActiveNodes: 0 }]);
    const launcherRegistry = new LauncherRegistry();
    launcherRegistry.register(launcherStub.endpoint, ["small-model"], launcherStub.port);
    const demandTracker = new DemandTracker();
    demandTracker.recordRequest("small-model");

    const manager = makeManager({ catalog, launcherRegistry, demandTracker });
    await manager.runOnce();

    assert.equal(launcherStub.getPipelineCalls(), 0);
  } finally {
    launcherStub.server.close();
  }
});

test("runOnce never claims a launcher already backing a live pool entry for a DIFFERENT model", async () => {
  const launcherStub = await startStubLauncher();
  try {
    const catalog = new ModelCatalog([
      { id: "model-a", displayName: "A", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 },
      { id: "model-b", displayName: "B", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 },
    ]);
    const launcherRegistry = new LauncherRegistry();
    // The one launcher available declares it can serve BOTH models.
    const launcherId = launcherRegistry.register(launcherStub.endpoint, ["model-a", "model-b"], launcherStub.port);
    const registry = new NodeRegistry();
    // NOTE: register() returns the sha256-derived nodeId, which is what a
    // PooledPipeline's driverNodeId field holds -- NOT the raw endpoint.
    // Putting an endpoint here instead would make the health check below
    // treat this entry as dead and free the launcher, quietly turning this
    // no-preemption test into a no-op that passes for the wrong reason.
    const driverNodeId = registry.register("http://127.0.0.1:1", "desktop");
    registry.register("http://127.0.0.1:2", "desktop");
    const pipelineTracker = new PipelineTracker();
    // Pre-populate model-a's pool with an entry already claiming this launcher.
    pipelineTracker.addEntry("model-a", {
      pipelineId: "existing",
      driverNodeId,
      computeNodeIds: [],
      launcherId,
      state: "warm",
      lastUsedAt: Date.now(),
    });
    const demandTracker = new DemandTracker();
    demandTracker.recordRequest("model-b");
    demandTracker.recordRequest("model-b");

    const manager = makeManager({ catalog, registry, launcherRegistry, demandTracker, pipelineTracker });
    await manager.runOnce();

    // model-b wanted a pipeline and had demand, but the only launcher
    // serving it was already claimed by model-a -- must NOT be touched.
    assert.equal(pipelineTracker.getPool("model-b").length, 0);
    assert.equal(pipelineTracker.getPool("model-a").length, 1);
    assert.equal(launcherStub.getPipelineCalls(), 0);
    assert.equal(launcherStub.getDeleteCalls(), 0);
  } finally {
    launcherStub.server.close();
  }
});

test("runOnce marks a pool entry failed and removes it when one of its nodes is no longer active", async () => {
  const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 2 }]);
  const registry = new NodeRegistry();
  const pipelineTracker = new PipelineTracker();
  pipelineTracker.addEntry("big-model", {
    pipelineId: "dead-entry",
    driverNodeId: "never-registered-node-id",
    computeNodeIds: [],
    launcherId: "some-launcher",
    state: "warm",
    lastUsedAt: Date.now(),
  });

  const manager = makeManager({ catalog, registry, pipelineTracker });
  await manager.runOnce();

  assert.equal(pipelineTracker.getPool("big-model").length, 0);
});

test("runOnce removes a pool entry another code path already marked failed, even though its nodes are still active", async () => {
  const launcherStub = await startStubLauncher();
  try {
    const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 }]);
    const registry = new NodeRegistry();
    const driverNodeId = registry.register("http://127.0.0.1:1", "desktop", undefined, "big-model");
    const launcherRegistry = new LauncherRegistry();
    const launcherId = launcherRegistry.register(launcherStub.endpoint, ["big-model"], launcherStub.port);
    const pipelineTracker = new PipelineTracker();
    pipelineTracker.addEntry("big-model", {
      pipelineId: "broken-entry",
      driverNodeId,
      computeNodeIds: [],
      launcherId,
      state: "warm",
      lastUsedAt: Date.now(),
    });
    // /generate marks the entry failed when a forward to its driver fails;
    // the driver is still "active" by registration timestamp, so the
    // node-liveness check alone would never reap this entry and its
    // launcher would stay claimed forever.
    pipelineTracker.markEntryFailed("big-model", "broken-entry");

    const manager = makeManager({ catalog, registry, launcherRegistry, pipelineTracker });
    await manager.runOnce();

    assert.equal(pipelineTracker.getPool("big-model").length, 0);
    assert.equal(launcherStub.getDeleteCalls(), 1);
  } finally {
    launcherStub.server.close();
  }
});

test("runOnce scales down a pool entry idle past the grace period, calling DELETE on its launcher", async () => {
  const launcherStub = await startStubLauncher();
  try {
    // requiredNodeCount MUST be > 1 for this model to be considered at all
    // -- a requiredNodeCount:1 model is invisible to the pool manager, so
    // with 1 here the scale-down step would never run and this test would
    // fail for a reason that has nothing to do with idleness.
    const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 }]);
    const registry = new NodeRegistry();
    const driverEndpoint = "http://127.0.0.1:1";
    const driverNodeId = registry.register(driverEndpoint, "desktop", undefined, "big-model");
    const launcherRegistry = new LauncherRegistry();
    const launcherId = launcherRegistry.register(launcherStub.endpoint, ["big-model"], launcherStub.port);
    const pipelineTracker = new PipelineTracker();
    // lastUsedAt is written by server.ts with a raw Date.now(), so the
    // manager's idle comparison must be against that same wall clock. An
    // injected/fake epoch on the manager's side would make this difference
    // meaningless and this teardown would never fire.
    const oldTimestamp = Date.now() - 400000; // well past a 300000ms (5 min) grace period
    pipelineTracker.addEntry("big-model", {
      pipelineId: "idle-entry",
      driverNodeId,
      computeNodeIds: [],
      launcherId,
      state: "warm",
      lastUsedAt: oldTimestamp,
    });
    const demandTracker = new DemandTracker(); // zero recent demand

    const manager = makeManager({ catalog, registry, launcherRegistry, pipelineTracker, demandTracker });
    await manager.runOnce();

    assert.equal(launcherStub.getDeleteCalls(), 1);
    assert.equal(pipelineTracker.getPool("big-model").length, 0);
    // Only one node is registered, so a 2-node pipeline can't be rebuilt
    // this tick -- the torn-down entry must not immediately churn back.
    assert.equal(launcherStub.getPipelineCalls(), 0);
  } finally {
    launcherStub.server.close();
  }
});

test("runOnce leaves a recently-used pool entry alone, and idleGraceMs is a real tunable", async () => {
  const launcherStub = await startStubLauncher();
  try {
    const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 }]);
    const registry = new NodeRegistry();
    const driverNodeId = registry.register("http://127.0.0.1:1", "desktop", undefined, "big-model");
    const launcherRegistry = new LauncherRegistry();
    const launcherId = launcherRegistry.register(launcherStub.endpoint, ["big-model"], launcherStub.port);
    const pipelineTracker = new PipelineTracker();
    const addEntry = () => pipelineTracker.addEntry("big-model", {
      pipelineId: "entry",
      driverNodeId,
      computeNodeIds: [],
      launcherId,
      state: "warm",
      lastUsedAt: Date.now() - 5000,
    });

    addEntry();
    await makeManager({ catalog, registry, launcherRegistry, pipelineTracker, idleGraceMs: 300000 }).runOnce();
    assert.equal(pipelineTracker.getPool("big-model").length, 1, "5s idle is well inside a 5-minute grace period");
    assert.equal(launcherStub.getDeleteCalls(), 0);

    pipelineTracker.removeEntry("big-model", "entry");
    addEntry();
    await makeManager({ catalog, registry, launcherRegistry, pipelineTracker, idleGraceMs: 1000 }).runOnce();
    assert.equal(pipelineTracker.getPool("big-model").length, 0, "5s idle is past a 1s grace period");
    assert.equal(launcherStub.getDeleteCalls(), 1);
  } finally {
    launcherStub.server.close();
  }
});

test("runOnce heartbeats a healthy entry's launcher-spawned driver so it doesn't age out between ticks", async () => {
  const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 }]);
  let fakeNow = Date.now();
  // 30000ms timeout == the reconciliation interval this manager runs at in
  // production, which is exactly why the driver has to be heartbeated: a
  // launcher-spawned driver is never pinged by anything else, so without
  // this it ages out of listActive() between two consecutive ticks and a
  // perfectly healthy warm pipeline gets torn down and rebuilt forever.
  const registry = new NodeRegistry(() => fakeNow, 30000);
  const driverNodeId = registry.register("http://127.0.0.1:1", "desktop", undefined, "big-model");
  const contributorNodeId = registry.register("http://127.0.0.1:2", "desktop");
  const pipelineTracker = new PipelineTracker();
  pipelineTracker.addEntry("big-model", {
    pipelineId: "warm-entry",
    driverNodeId,
    computeNodeIds: [contributorNodeId],
    launcherId: "launcher-not-registered",
    state: "warm",
    lastUsedAt: Date.now(),
  });

  const manager = makeManager({ catalog, registry, pipelineTracker });

  // Step by the cadence PRODUCTION actually runs at, not an arbitrary
  // number. Nothing but this loop ever pings a launcher-spawned driver, so
  // the gap between two consecutive ticks *is* that driver's heartbeat
  // period -- which means DEFAULT_INTERVAL_MS must leave real headroom under
  // the registry's 30s timeout. It previously equalled it exactly, and since
  // setInterval only ever fires late, the tie was lost in practice: the
  // driver aged out, the entry was judged dead, and a perfectly healthy idle
  // pipeline was torn down and respawned in a ~60s loop with zero traffic.
  //
  // The +5% models that late drift. Ten ticks is ~100s of simulated idle
  // time -- well past the point the old constant churned, and still short of
  // the 5-minute idle grace period, so nothing here should be torn down.
  const tickGap = Math.round(DEFAULT_INTERVAL_MS * 1.05);
  assert.ok(tickGap < 30000, `reconciliation interval ${DEFAULT_INTERVAL_MS}ms leaves no headroom under the registry's 30s node timeout`);

  for (let tick = 0; tick < 10; tick++) {
    fakeNow += tickGap;
    registry.heartbeat(contributorNodeId); // a real operator-run node pings for itself
    await manager.runOnce();

    assert.equal(pipelineTracker.getPool("big-model").length, 1, `pipeline was torn down on tick ${tick + 1}`);
    assert.equal(registry.listActive().some(n => n.nodeId === driverNodeId), true, `driver aged out of the registry on tick ${tick + 1}`);
  }
});

test("runOnce allocates a single idle launcher to the higher-demand of two competing under-provisioned models", async () => {
  const launcherStub = await startStubLauncher();
  try {
    const catalog = new ModelCatalog([
      { id: "model-low", displayName: "Low", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 },
      { id: "model-high", displayName: "High", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 },
    ]);
    const registry = new NodeRegistry();
    registry.register("http://127.0.0.1:1", "desktop");
    registry.register("http://127.0.0.1:2", "desktop");
    const launcherRegistry = new LauncherRegistry();
    // ONE launcher declares it can serve BOTH models -- only one of them
    // can actually get it this tick.
    launcherRegistry.register(launcherStub.endpoint, ["model-low", "model-high"], launcherStub.port);
    const demandTracker = new DemandTracker();
    demandTracker.recordRequest("model-low");
    for (let i = 0; i < 5; i++) demandTracker.recordRequest("model-high");
    const pipelineTracker = new PipelineTracker();

    const manager = makeManager({ catalog, registry, launcherRegistry, demandTracker, pipelineTracker });
    await manager.runOnce();

    assert.equal(pipelineTracker.getPool("model-high").length, 1);
    assert.equal(pipelineTracker.getPool("model-low").length, 0);
  } finally {
    launcherStub.server.close();
  }
});

test("runOnce scales one model up to several pipelines when demand justifies it, stopping at maxPipelines", async () => {
  const stubs = [await startStubLauncher(), await startStubLauncher(), await startStubLauncher()];
  try {
    const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 2 }]);
    const registry = new NodeRegistry();
    registry.register("http://127.0.0.1:1", "desktop");
    registry.register("http://127.0.0.1:2", "desktop");
    const launcherRegistry = new LauncherRegistry();
    for (const stub of stubs) launcherRegistry.register(stub.endpoint, ["big-model"], stub.port);
    const demandTracker = new DemandTracker();
    for (let i = 0; i < 15; i++) demandTracker.recordRequest("big-model"); // ceil(15/10) == 2
    const pipelineTracker = new PipelineTracker();

    const manager = makeManager({ catalog, registry, launcherRegistry, demandTracker, pipelineTracker });
    await manager.runOnce();

    const pool = pipelineTracker.getPool("big-model");
    assert.equal(pool.length, 2);
    assert.equal(new Set(pool.map(e => e.launcherId)).size, 2, "two pipelines must never share one launcher");
    assert.deepEqual(stubs.map(s => s.getPipelineCalls()), [1, 1, 0]);

    // A second tick with the pool already at its desired count must be a
    // complete no-op -- no churn, no third launcher claimed.
    await manager.runOnce();
    assert.equal(pipelineTracker.getPool("big-model").length, 2);
    assert.deepEqual(stubs.map(s => s.getPipelineCalls()), [1, 1, 0]);
    assert.deepEqual(stubs.map(s => s.getDeleteCalls()), [0, 0, 0]);
  } finally {
    for (const stub of stubs) stub.server.close();
  }
});

test("runOnce does not claim a launcher when the swarm has too few active nodes to form the pipeline", async () => {
  const launcherStub = await startStubLauncher();
  try {
    const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 3, maxPipelines: 1 }]);
    const registry = new NodeRegistry();
    registry.register("http://127.0.0.1:1", "desktop"); // only 1 of the 3 needed
    const launcherRegistry = new LauncherRegistry();
    launcherRegistry.register(launcherStub.endpoint, ["big-model"], launcherStub.port);
    const pipelineTracker = new PipelineTracker();

    const manager = makeManager({ catalog, registry, launcherRegistry, pipelineTracker });
    await manager.runOnce();

    assert.equal(launcherStub.getPipelineCalls(), 0);
    assert.equal(pipelineTracker.getPool("big-model").length, 0);
  } finally {
    launcherStub.server.close();
  }
});

test("runOnce tolerates a launcher that rejects the assembly request, leaving the pool empty and not throwing", async () => {
  const server = createHttpServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "spawn failed" }));
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound port");
  try {
    const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 }]);
    const registry = new NodeRegistry();
    registry.register("http://127.0.0.1:1", "desktop");
    registry.register("http://127.0.0.1:2", "desktop");
    const launcherRegistry = new LauncherRegistry();
    launcherRegistry.register(`http://127.0.0.1:${address.port}`, ["big-model"], address.port);
    const pipelineTracker = new PipelineTracker();

    const manager = makeManager({ catalog, registry, launcherRegistry, pipelineTracker });
    await manager.runOnce();

    assert.equal(pipelineTracker.getPool("big-model").length, 0);
  } finally {
    server.close();
  }
});

test("start() drives runOnce on its interval and stop() ends it", async () => {
  const launcherStub = await startStubLauncher();
  const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 }]);
  const registry = new NodeRegistry();
  registry.register("http://127.0.0.1:1", "desktop");
  registry.register("http://127.0.0.1:2", "desktop");
  const launcherRegistry = new LauncherRegistry();
  launcherRegistry.register(launcherStub.endpoint, ["big-model"], launcherStub.port);
  const pipelineTracker = new PipelineTracker();
  const manager = new PipelinePoolManager(
    catalog, registry, new ReputationTracker(), launcherRegistry, pipelineTracker,
    new DemandTracker(), Math.random, 5, 300000, 10,
  );
  try {
    manager.start();
    // Wait for a WARM entry, not merely a non-empty pool: tryAssemble now
    // reserves the launcher with an "assembling" entry before its POST
    // /pipeline call, so a non-empty pool no longer means assembly finished.
    const deadline = Date.now() + 3000;
    const isWarm = () => pipelineTracker.getPool("big-model").some(e => e.state === "warm");
    while (!isWarm() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(pipelineTracker.getPool("big-model").length, 1);
    assert.equal(isWarm(), true, "expected the assembly to have completed");
    manager.stop();
    const callsAtStop = launcherStub.getPipelineCalls();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(launcherStub.getPipelineCalls(), callsAtStop, "no further reconciliation after stop()");
  } finally {
    manager.stop();
    launcherStub.server.close();
  }
});

test("a launcher is claimed for the whole assembly window, not just after it succeeds", async () => {
  // Regression test for a cross-path double-claim found by whole-branch
  // live probing. tryAssemble() used to call addEntry() only AFTER its
  // POST /pipeline resolved, so for the entire assembly window the
  // launcher was invisible to claimedLauncherIds() -- and a concurrent
  // cold-start /generate for a DIFFERENT model read it as idle and
  // claimed it too. A swarm-launcher supervises one agent at a time, so
  // both models ended up with an entry pointing at a single agent running
  // only the later model's weights, and tearing down either killed the
  // other's agent.
  let releaseAssembly: () => void = () => {};
  const held = new Promise<void>(resolve => { releaseAssembly = resolve; });
  const server = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    await held; // hold POST /pipeline open so the assembly window is observable
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ready" }));
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected stub launcher to bind to a port");
  }
  const endpoint = `http://127.0.0.1:${address.port}`;

  const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 }]);
  const registry = new NodeRegistry();
  registry.register("http://127.0.0.1:1", "desktop");
  registry.register("http://127.0.0.1:2", "desktop");
  const pipelineTracker = new PipelineTracker();
  const launcherRegistry = new LauncherRegistry();
  const launcherId = launcherRegistry.register(endpoint, ["big-model"], address.port as number);
  const demandTracker = new DemandTracker();
  demandTracker.recordRequest("big-model");

  const manager = makeManager({ catalog, registry, pipelineTracker, launcherRegistry, demandTracker });

  try {
    const tick = manager.runOnce();
    // Yield until the reservation appears, without depending on a fixed sleep.
    for (let i = 0; i < 200 && pipelineTracker.getPool("big-model").length === 0; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }

    const claimedMidFlight = claimedLauncherIds(catalog, pipelineTracker);
    assert.equal(
      claimedMidFlight.has(launcherId),
      true,
      "the launcher must count as claimed while its assembly is still in flight, or a concurrent path will claim it too",
    );

    releaseAssembly();
    await tick;

    const pool = pipelineTracker.getPool("big-model");
    assert.equal(pool.length, 1, "the reservation must be swapped for the real entry, not left alongside it");
    assert.equal(pool[0].state, "warm");
    assert.equal(pool[0].launcherId, launcherId);
  } finally {
    releaseAssembly();
    server.close();
  }
});

test("tearing down an entry whose launcher registration has expired still stops its agent", async () => {
  // A lapsed LauncherRegistry entry does NOT mean the agent stopped --
  // registrations expire on their own heartbeat timeout. Teardown used to
  // look the endpoint up by launcherId only, find nothing, and silently
  // skip the DELETE, freeing the launcherId while an orphan agent kept
  // holding the port and the model's weights.
  const launcherStub = await startStubLauncher();
  const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 }]);
  let fakeNow = Date.now();
  const registry = new NodeRegistry();
  const launcherRegistry = new LauncherRegistry(() => fakeNow, 30000);
  const launcherId = launcherRegistry.register(launcherStub.endpoint, ["big-model"], launcherStub.port);
  const pipelineTracker = new PipelineTracker();
  pipelineTracker.addEntry("big-model", {
    pipelineId: "entry-with-expired-launcher",
    driverNodeId: "driver-not-in-the-registry", // dead -> teardown path
    computeNodeIds: [],
    launcherId,
    launcherEndpoint: launcherStub.endpoint,
    state: "warm",
    lastUsedAt: Date.now(),
  });

  const manager = makeManager({ catalog, registry, pipelineTracker, launcherRegistry });
  try {
    fakeNow += 60000; // the launcher's own registration lapses
    assert.equal(launcherRegistry.listActive().length, 0, "precondition: the launcher registration has expired");

    await manager.runOnce();

    assert.equal(pipelineTracker.getPool("big-model").length, 0, "the dead entry should be torn down");
    assert.equal(launcherStub.getDeleteCalls(), 1, "the agent must still be stopped even though its launcher registration lapsed");
  } finally {
    launcherStub.server.close();
  }
});

test("a launcher whose prospective driver is reputation-ejected is not spawned over and over", async () => {
  // A launcher-spawned driver's endpoint is fully determined by the
  // launcher (its host plus its fixed agentPort), and nodeId is sha256 of
  // that endpoint -- so an ejected driver inherits the ejection on every
  // respawn. The loop was unbreakable: assemble (POST succeeds), next
  // tick's health check finds the driver missing from listActive(
  // reputation) and tears it down, allocate re-claims the same launcher,
  // repeat -- a real multi-GB model load and kill every single tick.
  const launcherStub = await startStubLauncher();
  const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 }]);
  const registry = new NodeRegistry();
  registry.register("http://127.0.0.1:1", "desktop");
  registry.register("http://127.0.0.1:2", "desktop");
  const launcherRegistry = new LauncherRegistry();
  launcherRegistry.register(launcherStub.endpoint, ["big-model"], launcherStub.port);
  const pipelineTracker = new PipelineTracker();
  const reputation = new ReputationTracker();

  // Eject the exact driver this launcher would spawn, by its deterministic id.
  const launcherUrl = new URL(launcherStub.endpoint);
  const driverId = stableNodeId(`${launcherUrl.protocol}//${launcherUrl.hostname}:${launcherStub.port}`);
  for (let i = 0; i < 20; i++) reputation.recordDisagreement(driverId);
  assert.equal(reputation.isTrusted(driverId), false, "precondition: the prospective driver is ejected");

  const demandTracker = new DemandTracker();
  demandTracker.recordRequest("big-model");
  const manager = makeManager({ catalog, registry, pipelineTracker, launcherRegistry, reputation, demandTracker });

  try {
    for (let tick = 0; tick < 5; tick++) {
      await manager.runOnce();
    }
    assert.equal(launcherStub.getPipelineCalls(), 0, "an ejected driver must never be respawned -- it can never become selectable");
    assert.equal(pipelineTracker.getPool("big-model").length, 0);
  } finally {
    launcherStub.server.close();
  }
});

test("a launcher whose registration lapsed and re-registered is still recognised as claimed", async () => {
  // LauncherRegistry re-mints a randomUUID whenever a LAPSED registration
  // re-registers (it refreshes in place only while unexpired). Pool entries
  // still hold the old id, so a tally keyed on launcherId alone stopped
  // recognising the physical machine as busy -- even though its agent was
  // still running and its pool entry still alive -- and a second model
  // could claim the very same launcher.
  const catalog = new ModelCatalog([
    { id: "model-a", displayName: "A", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 },
    { id: "model-b", displayName: "B", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 },
  ]);
  let fakeNow = Date.now();
  const launcherRegistry = new LauncherRegistry(() => fakeNow, 30000);
  const endpoint = "http://127.0.0.1:59123";
  const oldLauncherId = launcherRegistry.register(endpoint, ["model-a", "model-b"], 59124);

  const pipelineTracker = new PipelineTracker();
  pipelineTracker.addEntry("model-a", {
    pipelineId: "a-1",
    driverNodeId: "driver-a",
    computeNodeIds: [],
    launcherId: oldLauncherId,
    launcherEndpoint: endpoint,
    state: "warm",
    lastUsedAt: Date.now(),
  });

  // The launcher goes quiet past its timeout, then comes back.
  fakeNow += 60000;
  const newLauncherId = launcherRegistry.register(endpoint, ["model-a", "model-b"], 59124);
  assert.notEqual(newLauncherId, oldLauncherId, "precondition: re-registering a lapsed launcher mints a new id");

  const claimed = claimedLauncherIds(catalog, pipelineTracker);
  const live = launcherRegistry.listActive().find(l => l.launcherId === newLauncherId)!;
  assert.equal(
    isLauncherClaimed(claimed, live),
    true,
    "the machine is still hosting model-a's pipeline, so it must not look idle just because its launcherId rotated",
  );
});

test("a plan that goes stale across an await does not claim a launcher the request path took meanwhile", async () => {
  // planAllocations() is pure and internally consistent, but allocate()
  // consumes its plan across `await tryAssemble(...)` boundaries. A real
  // model load holds the first claim's fetch open for seconds, and in that
  // window the REQUEST path can legitimately claim a launcher the plan had
  // earmarked for a later entry. Without a commit-time re-check the later
  // claim reserved it anyway: one launcher backing two models, same
  // driverNodeId, and a user served the wrong model's weights with a 200.
  const catalog = new ModelCatalog([
    { id: "model-a", displayName: "A", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 },
    { id: "model-b", displayName: "B", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 },
  ]);
  const registry = new NodeRegistry();
  registry.register("http://127.0.0.1:1", "desktop");
  registry.register("http://127.0.0.1:2", "desktop");
  const pipelineTracker = new PipelineTracker();
  const launcherRegistry = new LauncherRegistry();

  // L1 is slow, so the tick is still awaiting it when we simulate the
  // request path claiming L2 out from under the plan.
  let releaseL1: () => void = () => {};
  const l1Held = new Promise<void>(resolve => { releaseL1 = resolve; });
  const l1 = createHttpServer(async (req, res) => {
    for await (const _c of req) { /* drain */ }
    await l1Held;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ready" }));
  });
  await new Promise<void>(r => l1.listen(0, r));
  const l1Port = (l1.address() as any).port as number;
  const l2 = await startStubLauncher();

  launcherRegistry.register(`http://127.0.0.1:${l1Port}`, ["model-a"], l1Port);
  const l2Id = launcherRegistry.register(l2.endpoint, ["model-b"], l2.port);

  const demand = new DemandTracker();
  for (let i = 0; i < 10; i++) demand.recordRequest("model-a"); // a outranks b
  demand.recordRequest("model-b");

  const manager = makeManager({ catalog, registry, pipelineTracker, launcherRegistry, demandTracker: demand });
  try {
    const tick = manager.runOnce();
    for (let i = 0; i < 200 && pipelineTracker.getPool("model-a").length === 0; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }

    // The request path claims L2 while the tick is still blocked on L1.
    pipelineTracker.addEntry("model-b", {
      pipelineId: "taken-by-request-path",
      driverNodeId: "some-driver",
      computeNodeIds: [],
      launcherId: l2Id,
      launcherEndpoint: l2.endpoint,
      state: "warm",
      lastUsedAt: Date.now(),
    });

    releaseL1();
    await tick;

    assert.equal(l2.getPipelineCalls(), 0, "the tick must not spawn on a launcher that was claimed while its plan was in flight");
    assert.equal(pipelineTracker.getPool("model-b").length, 1, "model-b keeps only the request path's entry -- the tick must not add a second");
  } finally {
    releaseL1();
    l1.close();
    l2.server.close();
  }
});
