// Randomized interleaving test for the launcher / pipeline reservation state
// machine (server.ts's cold-start assembly + PipelinePoolManager).
//
// WHY THIS EXISTS. The endpoint-identity-hardening branch went through nine
// whole-branch review rounds, and seven of the first eight found a genuine
// Critical/Important bug -- several of them regressions introduced by the
// immediately preceding round's own fix. Each round read a diff. The ninth
// round instead built this harness, and within seconds it found five
// invariant violations that eight rounds of reading had missed (a request
// answered 200 with ANOTHER model's weights; a prompt handed to an endpoint
// this coordinator never spawned; a launcher starved by one ejected driver;
// a DELETE killing a freshly spawned agent; maxPipelines exceeded). The
// state machine is too concurrent to be judged by reading, so this makes its
// invariants executable and enforces them on every future change.
//
// HOW IT WORKS. Everything is deterministic per seed. A virtual clock
// (Date.now is overridden) and an in-process fake network (globalThis.fetch
// is replaced) drive the REAL createServer() request handler and the REAL
// PipelinePoolManager.runOnce(). Stub launchers model the real
// single-threaded swarm-launcher (FIFO, one agent at a time, a POST replaces
// the previous agent in place, DELETE is idempotent and not tied to an agent
// generation). Every network completion is an explicit, RNG-chosen step, so
// the interleaving of concurrent /generate calls, forward failures, slow or
// timed-out launcher calls, squatters, launcher lapses and re-registrations
// under another alias, reputation ejections and reconciliation ticks is fully
// controlled and reproducible from the seed.
//
// INVARIANTS CHECKED after every step: a 200 always carries the REQUESTED
// model's weights; no prompt is ever answered by a squatter; one launcher
// never backs two models; never two live entries on one launcher; live
// entries never exceed maxPipelines; no DELETE is issued to a launcher while
// an assembly on it is in flight; no DELETE kills an agent a routable warm
// entry points at; a new warm entry always matches the agent actually
// running. At quiescence: no entry stuck "assembling" or "failed", every warm
// entry still has its agent, and no model is starved while a free, trusted,
// unsquatted launcher exists for it.
//
// A failure prints the seed and event trace. Reproduce by calling
// runSeed(seed, steps, config) with `verbose: true`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createServer } from "../src/server.ts";
import { NodeRegistry, stableNodeId } from "../src/registry.ts";
import { ModelCatalog } from "../src/catalog.ts";
import { PeerRegistry } from "../src/peer_registry.ts";
import { LauncherRegistry } from "../src/launcher_registry.ts";
import { PipelineTracker } from "../src/pipeline_tracker.ts";
import { PipelinePoolManager, isDriverIdentitySquatted, launcherDriverIdentityKey } from "../src/pipeline_pool_manager.ts";
import { DemandTracker } from "../src/demand_tracker.ts";
import { KeywordSafetyClassifier } from "../src/safety_classifier.ts";
import { ReputationTracker } from "../src/reputation_tracker.ts";

const TOKEN = "state-machine-test-token-0123456789";
const T0 = 1_700_000_000_000;

interface Config {
  // true: a POST's agent becoming ready and its 200 response are one step
  // (the real launcher only responds after its own health check). false: two
  // steps, so a request can land while the new agent is already listening but
  // the coordinator has not yet been told -- the window in which a stale
  // driver registration used to be mistaken for the new model's agent.
  atomicSpawn?: boolean;
  // Weight of the "plant a squatter on a driver identity" action (0 = never).
  squatWeight?: number;
  // Never eject/rehab a driver's reputation.
  noEject?: boolean;
}

interface Violation {
  code: string;
  msg: string;
}

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canonHost(h: string): string {
  h = h.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1") return "loopback";
  return h;
}

const settle = async (n = 40) => {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
};

async function runSeed(seed: number, steps: number, config: Config = {}, verbose = false): Promise<{ violations: Violation[]; trace: string[] }> {
  let vnow = T0;
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  Date.now = () => vnow;

  const rnd = mulberry32(seed);
  const ri = (n: number) => Math.floor(rnd() * n);
  const pick = <T,>(arr: T[]): T => arr[ri(arr.length)];
  const chance = (p: number) => rnd() < p;

  const trace: string[] = [];
  const violations: Violation[] = [];
  const log = (s: string) => {
    trace.push(`[${trace.length}] t=${(vnow - T0) / 1000}s ${s}`);
    if (verbose) console.log(trace[trace.length - 1]);
  };
  const violate = (code: string, msg: string) => {
    violations.push({ code, msg });
    log(`!!! VIOLATION ${code}: ${msg}`);
  };
  console.warn = (...a: unknown[]) => {
    if (verbose) log(`warn: ${a.map(String).join(" ").slice(0, 160)}`);
  };

  try {
    // ---- world ----
    const nModels = 1 + ri(3);
    const models = Array.from({ length: nModels }, (_, i) => `m${i}`);
    const catalogEntries = models.map(id => ({ id, displayName: id, minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 + ri(2) }));
    const nLaunchers = 1 + ri(3);
    const launchers = Array.from({ length: nLaunchers }, (_, i) => ({
      idx: i,
      port: 7100 + i,
      agentPort: 8100 + i,
      host: chance(0.5) ? "127.0.0.1" : "localhost",
      servesModels: models.filter(() => chance(0.8)),
      queue: [] as any[],
      agent: undefined as undefined | { model: string; gen: number },
      launcherId: undefined as undefined | string,
      _rotatePending: false,
      _skipUntil: 0,
    }));
    for (const L of launchers) if (L.servesModels.length === 0) L.servesModels = [pick(models)];
    const idleGraceMs = chance(0.5) ? 300000 : 15000 + ri(30000);

    const registry = new NodeRegistry();
    const catalog = new ModelCatalog(catalogEntries);
    const reputation = new ReputationTracker();
    const launcherRegistry = new LauncherRegistry();
    const pipelineTracker = new PipelineTracker();
    const demandTracker = new DemandTracker();
    const server = createServer(registry, catalog, new PeerRegistry(), new KeywordSafetyClassifier([]), reputation, TOKEN, rnd, launcherRegistry, pipelineTracker, demandTracker);
    const manager = new PipelinePoolManager(catalog, registry, reputation, launcherRegistry, pipelineTracker, demandTracker, rnd, 10000, idleGraceMs);

    // Which entry the reaper is currently tearing down, so a DELETE that
    // kills THAT entry's own agent is not reported as killing a live one.
    let reaperTarget: any;
    const proto = PipelinePoolManager.prototype as any;
    const origTearDown = proto.tearDown;
    proto.tearDown = function (modelId: string, entry: any) {
      reaperTarget = entry;
      try {
        return origTearDown.call(this, modelId, entry);
      } finally {
        reaperTarget = undefined;
      }
    };

    try {
      log(`world: models=${JSON.stringify(catalogEntries.map(e => [e.id, e.maxPipelines]))} launchers=${JSON.stringify(launchers.map(l => [l.host + ":" + l.port, l.agentPort, l.servesModels]))} idleGraceMs=${idleGraceMs}`);

      // compute contributors (raw rpc servers, never contacted)
      const computeNodes = [0, 1, 2].map(i => ({ endpoint: `http://10.0.0.${i + 1}:50052`, key: `10.0.0.${i + 1}:50052` }));
      for (const c of computeNodes) registry.register(c.endpoint, c.key, "desktop");

      // ---- fake network ----
      let reqCounter = 0;
      let quiescent = false;
      let genCounter = 0;
      const pendingAgent: any[] = [];
      const launcherByPort = new Map(launchers.map(l => [l.port, l]));
      const launcherByAgentPort = new Map(launchers.map(l => [l.agentPort, l]));
      const entryGen = new Map<string, { L: any; gen: number; model: string }>();

      const refused = () => {
        const e: any = new TypeError("fetch failed");
        e.cause = { code: "ECONNREFUSED" };
        return Promise.reject(e);
      };
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

      // Routable = what /generate would actually send a prompt to: a warm
      // entry whose driver is active, trusted AND still bound to the
      // endpoint the pipeline spawned (a re-registration of the same
      // identity under a different endpoint is not that pipeline).
      const routable = (entry: any) => {
        if (entry.state !== "warm") return false;
        return registry.listActive(reputation).some(n => n.nodeId === entry.driverNodeId && (entry.driverEndpoint === undefined || n.endpoint === entry.driverEndpoint));
      };
      const allEntries = () => {
        const out: Array<{ m: string; e: any }> = [];
        for (const m of models) for (const e of pipelineTracker.getPool(m)) out.push({ m, e });
        return out;
      };
      const launcherOfEntry = (e: any) => launcherByPort.get(Number(e.launcherIdentityKey?.split(":").pop()));

      (globalThis as any).fetch = (input: any, init: any = {}) => {
        const url = new URL(String(input));
        const method = (init.method ?? "GET").toUpperCase();
        const port = Number(url.port);
        const host = canonHost(url.hostname);
        const body = init.body ? JSON.parse(init.body) : undefined;
        const id = ++reqCounter;
        if (host.endsWith(".evil")) {
          // a squatter's endpoint: a different process entirely
          if (url.pathname === "/complete") return Promise.resolve(json(200, { text: "SQUATTER" }));
          if (url.pathname === "/identity") return Promise.resolve(json(200, { nonce: body?.nonce, deviceTier: "desktop" }));
          return refused();
        }
        if (host !== "loopback") return refused();
        const L = launcherByPort.get(port);
        if (L) {
          if (url.pathname === "/identity") return Promise.resolve(json(200, { nonce: body?.nonce, agentPort: L.agentPort }));
          if (url.pathname !== "/pipeline") return refused();
          const stack = new Error().stack ?? "";
          const origin = /tearDown/.test(stack) ? "reaper" : /tryAssemble/.test(stack) ? "bg-assemble" : /assemblePipeline/.test(stack) ? "req-path" : "other";
          return new Promise((resolve, reject) => {
            const r: any = { id, method, model: body?.model, resolve, reject, abandoned: false, phase: 0, origin, target: reaperTarget, issuedVNOW: vnow };
            if (method === "DELETE") {
              const inflightPost = L.queue.find((q: any) => q.method === "POST" && !q.abandoned);
              if (inflightPost) violate("DELETE_DURING_ASSEMBLY", `DELETE #${id} (${origin}) issued to L${L.idx} while POST #${inflightPost.id} (${inflightPost.model}, ${inflightPost.origin}) is in flight`);
            }
            L.queue.push(r);
            log(`net: ${method} /pipeline #${id} -> L${L.idx}${body?.model ? " model=" + body.model : ""} (${origin})`);
          });
        }
        const A = launcherByAgentPort.get(port);
        if (A) {
          if (!A.agent) return refused();
          if (url.pathname === "/identity") return Promise.resolve(json(200, { nonce: body?.nonce, deviceTier: "desktop", servesModel: A.agent.model }));
          if (url.pathname === "/complete") {
            return new Promise((resolve, reject) => {
              const reg = registry.listActive().find(n => n.nodeId === stableNodeId(`loopback:${port}`));
              const postInFlight = A.queue.some((q: any) => q.method === "POST");
              const tag = `regServes=${reg?.servesModel} agent=${A.agent!.model} postInFlight=${postInFlight}`;
              log(`agent L${A.idx}: /complete #${id} accepted [${tag}]`);
              pendingAgent.push({ id, L: A, gen: A.agent!.gen, model: A.agent!.model, resolve, reject, stream: body?.stream === true, tag });
            });
          }
          return refused();
        }
        return refused();
      };

      const killAgent = (L: any, why: { desc: string; target: any }) => {
        if (!L.agent) return;
        const g = L.agent.gen;
        for (const { m, e } of allEntries()) {
          const b = entryGen.get(e.pipelineId);
          if (b && b.L === L && b.gen === g && routable(e)) {
            if (why.target !== e) violate("KILLED_LIVE_AGENT", `${why.desc} on L${L.idx} killed gen ${g} (${L.agent.model}) backing routable warm entry ${e.pipelineId.slice(0, 6)} of ${m}`);
          }
        }
        for (let i = pendingAgent.length - 1; i >= 0; i--) {
          if (pendingAgent[i].L === L && pendingAgent[i].gen === g) {
            const p = pendingAgent.splice(i, 1)[0];
            const e: any = new TypeError("fetch failed");
            e.cause = { code: "ECONNRESET" };
            p.reject(e);
          }
        }
        L.agent = undefined;
      };

      const launcherStep = async (L: any) => {
        const r = L.queue[0];
        if (!r) return false;
        if (r.method === "DELETE") {
          L.queue.shift();
          log(`L${L.idx}: process DELETE #${r.id} (${r.origin}) agent=${L.agent ? L.agent.model + "/g" + L.agent.gen : "none"}`);
          killAgent(L, { desc: `DELETE #${r.id} (${r.origin})`, target: r.target });
          if (!r.abandoned) r.resolve(new Response(null, { status: 204 }));
          return true;
        }
        if (r.phase === 0) {
          killAgent(L, { desc: `POST #${r.id} replace`, target: undefined });
          if (!quiescent && chance(0.08)) {
            L.queue.shift();
            log(`L${L.idx}: POST #${r.id} spawn FAILED`);
            if (!r.abandoned) r.resolve(json(500, { error: "spawn failed" }));
            return true;
          }
          L.agent = { model: r.model, gen: ++genCounter };
          r.phase = 1;
          r.gen = L.agent.gen;
          log(`L${L.idx}: POST #${r.id} agent ready model=${r.model} gen=${L.agent.gen} (response not yet sent)`);
          if (!config.atomicSpawn) return true;
        }
        L.queue.shift();
        log(`L${L.idx}: POST #${r.id} respond 200${r.abandoned ? " (abandoned by coordinator)" : ""}`);
        if (!r.abandoned) r.resolve(json(200, { status: "ready" }));
        return true;
      };

      // ---- route invocation ----
      const callRoute = (method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> =>
        new Promise((resolve) => {
          const req: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
          req.method = method;
          req.url = path;
          req.headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
          let status = 0;
          const chunks: Buffer[] = [];
          const res: any = {
            headersSent: false,
            writeHead(s: number) { status = s; this.headersSent = true; return this; },
            write(c: any) { chunks.push(Buffer.from(c)); return true; },
            end(c?: any) { if (c) chunks.push(Buffer.from(c)); resolve({ status, body: Buffer.concat(chunks).toString() }); },
            setHeader() {},
          };
          server.emit("request", req, res);
        });

      let reqNo = 0;
      const startGenerate = (model: string, kind: "generate" | "chat") => {
        const n = ++reqNo;
        log(`client: ${kind} #${n} model=${model}`);
        const p = kind === "chat"
          ? callRoute("POST", "/v1/chat/completions", { model, messages: [{ role: "user", content: "hi" }] })
          : callRoute("POST", "/generate", { prompt: "hi", modelId: model });
        p.then(({ status, body }) => {
          let text: string | undefined;
          try {
            const j = JSON.parse(body);
            text = kind === "chat" ? j.choices?.[0]?.message?.content : j.text;
          } catch { /* not JSON */ }
          log(`client: ${kind} #${n} model=${model} -> ${status}${text ? " text=" + text : ""}`);
          if (status === 200) {
            if (text === "SQUATTER") violate("SQUATTER_SERVED", `${kind} #${n} for ${model} answered by squatter`);
            else if (!text || !text.startsWith(`model=${model};`)) violate("WRONG_WEIGHTS", `${kind} #${n} asked ${model}, got ${text}`);
          }
          if (status === 500) violate("HTTP_500", `${kind} #${n}: ${body}`);
        });
      };

      const registerLauncher = async (L: any, host: string) => {
        L.host = host;
        const r = await callRoute("POST", "/launchers/register", { endpoint: `http://${host}:${L.port}`, servesModels: L.servesModels, agentPort: L.agentPort });
        if (r.status === 200) L.launcherId = JSON.parse(r.body).launcherId;
        log(`launcher L${L.idx} register as ${host} -> ${r.status} id=${L.launcherId?.slice(0, 6)}`);
      };
      for (const L of launchers) {
        await registerLauncher(L, L.host);
        await settle();
      }

      // ---- bookkeeping after each step ----
      const bindNewWarmEntries = () => {
        for (const { m, e } of allEntries()) {
          if (e.state === "warm" && !entryGen.has(e.pipelineId)) {
            const L = launcherOfEntry(e);
            if (!L || !L.agent) {
              violate("WARM_WITHOUT_AGENT", `new warm entry ${e.pipelineId.slice(0, 6)} of ${m} on L${L?.idx} but launcher has no agent`);
              entryGen.set(e.pipelineId, { L, gen: -1, model: m });
              continue;
            }
            if (L.agent.model !== m) violate("WARM_WRONG_AGENT", `new warm entry ${e.pipelineId.slice(0, 6)} of ${m} on L${L.idx} but agent runs ${L.agent.model}`);
            entryGen.set(e.pipelineId, { L, gen: L.agent.gen, model: m });
            log(`pool: + warm ${m} ${e.pipelineId.slice(0, 6)} on L${L.idx} gen=${L.agent.gen}`);
          }
        }
      };
      const structuralChecks = () => {
        const byLauncher = new Map<any, Array<{ m: string; e: any }>>();
        for (const { m, e } of allEntries()) {
          const L = launcherOfEntry(e);
          const k = L ? L.idx : e.launcherIdentityKey;
          if (!byLauncher.has(k)) byLauncher.set(k, []);
          byLauncher.get(k)!.push({ m, e });
        }
        for (const [k, list] of byLauncher) {
          const ms = new Set(list.map(x => x.m));
          if (ms.size > 1) violate("CROSS_MODEL_SHARE", `L${k} has entries of ${[...ms].join(",")}: ${list.map(x => x.m + ":" + x.e.state).join(" ")}`);
          // A launcher backs ONE agent, so at most one ROUTABLE warm entry may
          // point at it. A warm entry plus an "assembling" reservation for the
          // same model is the by-design replace-in-place overlap, not a violation.
          const live = list.filter(x => routable(x.e));
          if (live.length > 1) violate("DOUBLE_LIVE", `L${k} has ${live.length} routable warm entries: ${live.map(x => x.m + ":" + x.e.state).join(" ")}`);
        }
        for (const m of models) {
          // routable WARM pipelines, not warm + assembling: an in-flight
          // replacement legitimately overlaps the entry it is replacing (that
          // entry is retired, or marked failed, before the replacement turns
          // warm). What must never exceed the cap is what can actually serve.
          const live = pipelineTracker.getPool(m).filter(e => routable(e)).length;
          if (live > catalog.maxPipelines(m)) violate("OVER_MAX", `${m} has ${live} routable warm entries > max ${catalog.maxPipelines(m)}`);
        }
      };
      const snapshot = () => models.map(m => `${m}[${pipelineTracker.getPool(m).map(e => `${e.state[0]}:${(launcherOfEntry(e)?.idx ?? "?")}:${e.pipelineId.slice(0, 4)}`).join(",")}]`).join(" ") +
        " | " + launchers.map(L => `L${L.idx}:${L.agent ? L.agent.model + "/g" + L.agent.gen : "-"}${L.queue.length ? "q" + L.queue.map((q: any) => q.method[0] + q.id + (q.abandoned ? "x" : "")).join("") : ""}`).join(" ");

      // ---- main loop ----
      let ticking = false;
      let lastTickAt = vnow;
      const startTick = () => {
        if (ticking) return;
        ticking = true;
        lastTickAt = vnow;
        log("tick: start");
        manager.runOnce().catch(err => violate("TICK_THREW", String(err))).finally(() => { ticking = false; log("tick: end"); });
      };

      const squatWeight = config.squatWeight ?? 3;
      const actions: Array<[number, () => void]> = [
        [18, () => startGenerate(pick(models), "generate")],
        [3, () => startGenerate(pick(models), "chat")],
        [22, () => { const busy = launchers.filter(l => l.queue.length); if (busy.length) void launcherStep(pick(busy)); }],
        [12, () => {
          if (!pendingAgent.length) return;
          const p = pendingAgent.splice(ri(pendingAgent.length), 1)[0];
          if (chance(0.15)) {
            log(`agent L${p.L.idx}: /complete #${p.id} -> 500`);
            p.resolve(json(500, { error: "boom" }));
          } else {
            log(`agent L${p.L.idx}: /complete #${p.id} -> 200 model=${p.model}`);
            if (p.stream) p.resolve(new Response(`data: ${JSON.stringify({ token: `model=${p.model};gen=${p.gen};${p.tag}` })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } }));
            else p.resolve(json(200, { text: `model=${p.model};gen=${p.gen};${p.tag}`, prompt_tokens: 1, completion_tokens: 1 }));
          }
        }],
        [8, () => startTick()],
        [10, () => {
          const dt = 1000 + ri(12000);
          vnow += dt;
          // production ticks every 10s unless one is already running
          if (vnow - lastTickAt >= 10000) startTick();
          for (const c of computeNodes) if (chance(0.97)) registry.heartbeat(stableNodeId(c.key));
          for (const L of launchers) {
            if (chance(0.92) && L.launcherId && !(L._skipUntil > vnow)) {
              if (!launcherRegistry.heartbeat(L.launcherId)) {
                const host = chance(0.5) ? "127.0.0.1" : "localhost";
                log(`launcher L${L.idx} lapsed; re-registering`);
                void registerLauncher(L, host);
              }
            }
          }
          log(`time +${dt}ms`);
        }],
        [2, () => { // make a launcher miss heartbeats long enough to lapse and rotate its launcherId
          const L = pick(launchers);
          log(`launcher L${L.idx} forced rotation`);
          L._rotatePending = true;
        }],
        [squatWeight, () => { // a squatter on some launcher's driver identity (the disclosed DNS-alias / rebinding residual)
          const spawning = launchers.filter(l => l.queue.some((q: any) => q.method === "POST"));
          const L = spawning.length && chance(0.7) ? pick(spawning) : pick(launchers);
          const ep = `http://sq${L.agentPort}.evil:${L.agentPort}`;
          registry.register(ep, `loopback:${L.agentPort}`, "desktop", undefined, undefined);
          log(`squat: planted ${ep} on identity loopback:${L.agentPort}`);
        }],
        [3, () => { // a third party registers a driver endpoint via the public route
          const L = pick(launchers);
          const host = chance(0.5) ? "127.0.0.1" : "localhost";
          const claim = chance(0.5) ? pick(models) : undefined;
          void callRoute("POST", "/nodes/register", { endpoint: `http://${host}:${L.agentPort}`, deviceTier: "desktop", ...(claim ? { servesModel: claim } : {}) })
            .then(r => log(`nodes/register http://${host}:${L.agentPort} claim=${claim} -> ${r.status}`));
        }],
        [2, () => { // a coordinator-side launcher request gives up (timeout); the launcher still processes it
          const all = launchers.flatMap(L => L.queue.filter((q: any) => !q.abandoned && vnow - q.issuedVNOW >= 60000).map((q: any) => ({ L, q })));
          if (!all.length) return;
          const { L, q } = pick(all);
          q.abandoned = true;
          log(`net: ${q.method} #${q.id} to L${L.idx} TIMES OUT at coordinator`);
          q.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        }],
        [config.noEject ? 0 : 1, () => { // reputation: eject or rehab a launcher's driver identity
          const L = pick(launchers);
          const id = stableNodeId(launcherDriverIdentityKey({ identityKey: `loopback:${L.port}`, agentPort: L.agentPort } as any));
          if (chance(0.6)) {
            for (let i = 0; i < 6; i++) reputation.recordDisagreement(id);
            log(`reputation: eject driver of L${L.idx}`);
          } else {
            for (let i = 0; i < 12; i++) reputation.recordAgreement(id);
            log(`reputation: rehab driver of L${L.idx}`);
          }
        }],
      ];
      const totalW = actions.reduce((s, a) => s + a[0], 0);

      for (let step = 0; step < steps; step++) {
        let x = rnd() * totalW;
        for (const [w, f] of actions) {
          if ((x -= w) < 0) { f(); break; }
        }
        for (const L of launchers) {
          if (L._rotatePending && chance(0.3)) {
            L._rotatePending = false;
            L._skipUntil = vnow + 40000;
          }
        }
        await settle();
        bindNewWarmEntries();
        structuralChecks();
        if (verbose) log(`state: ${snapshot()}`);
      }

      // ---- quiescence: drain everything, let ticks run, squatters expire ----
      quiescent = true;
      log(`=== quiescence === ${snapshot()}`);
      for (let round = 0; round < 12; round++) {
        for (let k = 0; k < 20; k++) {
          let progressed = false;
          for (const L of launchers) if (await launcherStep(L)) progressed = true;
          while (pendingAgent.length) {
            const p = pendingAgent.shift();
            p.resolve(json(200, { text: `model=${p.model};gen=${p.gen}` }));
            progressed = true;
          }
          await settle();
          bindNewWarmEntries();
          if (!progressed && !ticking) break;
        }
        vnow += 5000;
        for (const c of computeNodes) registry.heartbeat(stableNodeId(c.key));
        for (const L of launchers) if (L.launcherId && !launcherRegistry.heartbeat(L.launcherId)) await registerLauncher(L, L.host);
        if (!ticking) startTick();
        await settle();
        bindNewWarmEntries();
        structuralChecks();
      }
      for (let k = 0; k < 40; k++) {
        for (const L of launchers) await launcherStep(L);
        while (pendingAgent.length) {
          const p = pendingAgent.shift();
          p.resolve(json(200, { text: `model=${p.model};gen=${p.gen}` }));
        }
        await settle();
      }
      for (let k = 0; k < 50 && ticking; k++) {
        for (const L of launchers) await launcherStep(L);
        await settle();
      }
      bindNewWarmEntries();
      log(`=== final === ${snapshot()}`);
      for (const { m, e } of allEntries()) {
        if (e.state === "assembling") violate("STUCK_ASSEMBLING", `${m} ${e.pipelineId.slice(0, 6)} on L${launcherOfEntry(e)?.idx}`);
        if (e.state === "failed") violate("STUCK_FAILED", `${m} ${e.pipelineId.slice(0, 6)} on L${launcherOfEntry(e)?.idx}`);
        if (e.state === "warm") {
          const L = launcherOfEntry(e);
          if (!L?.agent || L.agent.model !== m) violate("FINAL_WARM_INCONSISTENT", `${m} warm entry ${e.pipelineId.slice(0, 6)} on L${L?.idx} but agent=${L?.agent?.model}`);
        }
      }
      // liveness: a model with no warm entry although a free, trusted,
      // unsquatted launcher serving it exists
      const claimedIdx = new Set(allEntries().map(x => launcherOfEntry(x.e)?.idx));
      const activeLaunchers = launcherRegistry.listActive();
      for (const m of models) {
        if (pipelineTracker.getPool(m).some(e => e.state === "warm")) continue;
        for (const li of activeLaunchers.filter(l => l.servesModels.includes(m))) {
          const L = launcherByPort.get(Number(li.identityKey.split(":").pop()))!;
          if (claimedIdx.has(L.idx)) continue;
          const trusted = reputation.isTrusted(stableNodeId(launcherDriverIdentityKey(li)));
          const squatted = isDriverIdentitySquatted(registry, li);
          if (trusted && !squatted) violate("STARVED", `${m} has no warm pipeline but L${L.idx} is free, trusted and unsquatted`);
        }
      }
    } finally {
      proto.tearDown = origTearDown;
    }
    (server as any).close?.();
    return { violations, trace };
  } finally {
    Date.now = realNow;
    (globalThis as any).fetch = realFetch;
    console.warn = realWarn;
  }
}

function formatFailure(seed: number, config: Config, steps: number, v: Violation[]): string {
  return `seed ${seed} (steps=${steps}, config=${JSON.stringify(config)}): ` +
    v.slice(0, 3).map(x => `${x.code}: ${x.msg}`).join(" | ") +
    `\nReproduce with runSeed(${seed}, ${steps}, ${JSON.stringify(config)}, true).`;
}

// The seed counts below keep `npm test` fast. For a deep run -- do this after
// ANY change to server.ts's cold-start assembly or to pipeline_pool_manager.ts
// -- scale them up: `STATE_MACHINE_SEED_SCALE=40 npm test`. (Each seed is
// independent and deterministic; a failure prints the seed to reproduce.)
const SEED_SCALE = Math.max(1, Number(process.env.STATE_MACHINE_SEED_SCALE ?? 1) || 1);

async function sweep(firstSeed: number, baseCount: number, steps: number, config: Config) {
  const count = baseCount * SEED_SCALE;
  const failures: string[] = [];
  for (let seed = firstSeed; seed < firstSeed + count; seed++) {
    const { violations } = await runSeed(seed, steps, config);
    if (violations.length) failures.push(formatFailure(seed, config, steps, violations));
  }
  assert.deepEqual(failures, [], `${failures.length} of ${count} seeds violated an invariant:\n${failures.slice(0, 5).join("\n")}`);
}

// Seeds that exposed real bugs during the ninth review (each failed before
// the fixes in that round): 36/80/83 = a request answered with another
// model's weights through a stale launcher-spawned driver registration;
// 40/55/74 = a launcher starved by one reputation-ejected driver;
// 62 = a warm entry following its driver identity to a squatter's endpoint;
// 3 = maxPipelines exceeded by a stale plan.
test("pipeline state machine: seeds that exposed real bugs stay fixed", async () => {
  for (const seed of [3, 36, 40, 47, 55, 62, 74, 80, 83, 105, 114]) {
    const { violations } = await runSeed(seed, 300);
    assert.deepEqual(violations, [], formatFailure(seed, {}, 300, violations));
  }
});

test("pipeline state machine: randomized interleavings uphold every invariant (default config)", async () => {
  await sweep(1, 60, 300, {});
});

test("pipeline state machine: randomized interleavings uphold every invariant (atomic spawn, no ejection)", async () => {
  await sweep(1001, 40, 400, { atomicSpawn: true, noEject: true });
});

test("pipeline state machine: randomized interleavings uphold every invariant (squatter-heavy, no ejection)", async () => {
  await sweep(2001, 40, 300, { atomicSpawn: true, noEject: true, squatWeight: 10 });
});

test("pipeline state machine: randomized interleavings uphold every invariant (no squatters, no ejection)", async () => {
  await sweep(3001, 30, 500, { atomicSpawn: true, noEject: true, squatWeight: 0 });
});
