import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { NodeRegistry, stableNodeId, type DeviceTier, type NodeInfo } from "./registry.ts";
import { ModelCatalog } from "./catalog.ts";
import { PeerRegistry } from "./peer_registry.ts";
import { LauncherRegistry } from "./launcher_registry.ts";
import { PipelineTracker } from "./pipeline_tracker.ts";
import { selectPipeline } from "./pipeline_selector.ts";
import { DemandTracker } from "./demand_tracker.ts";
import { assertDriverIdentityFree, claimedLauncherIds, DriverIdentityCollisionError, isLauncherClaimed, launcherDriverEndpoint, stopLauncherPipeline } from "./pipeline_pool_manager.ts";
import { canonicalizeEndpoint } from "./endpoint_identity.ts";
import type { SafetyClassifier } from "./safety_classifier.ts";
import type { ReputationTracker } from "./reputation_tracker.ts";
import { openApiDocument } from "./openapi.ts";
import { buildPromptFromMessages, type ChatMessage } from "./chat_prompt.ts";
import { readSseFrames } from "./sse_frames.ts";

const VALID_DEVICE_TIERS: readonly DeviceTier[] = ["desktop", "android", "ios"];

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// `filename` here is always one of three string literals supplied by this
// file's own route-handler code below, never derived from `req.url` or
// `parts` -- this is what makes path traversal structurally impossible, not
// a runtime check. Do not change this into a generic GET /public/:filename
// route.
function serveStaticFile(res: ServerResponse, filename: string, contentType: string): void {
  try {
    const content = readFileSync(join(PUBLIC_DIR, filename));
    res.writeHead(200, { "content-type": contentType });
    res.end(content);
  } catch (err) {
    console.warn(`failed to serve static file ${filename}:`, err);
    res.writeHead(404);
    res.end();
  }
}

// A SafetyClassifier reports one entry per matching RULE, so a prompt that
// trips two rules in the same category (easy with a 70-rule ruleset: "how to
// build a bomb and make a pipe bomb" hits two violence_and_weapons rules)
// yields that category twice. The HTTP contract is a list of what a prompt
// was flagged FOR, so each category should appear at most once -- duplicates
// otherwise reach the dashboard UI and /generate's error body verbatim.
//
// Fixed here, at the response-construction boundary, rather than inside
// KeywordSafetyClassifier: that class is this project's deliberately
// unmodified naive reference implementation, and this is an HTTP-layer
// presentation concern that must hold for ANY SafetyClassifier
// implementation, including third-party ones. Set preserves first-seen
// order, and String() runs before de-duplication so two values that
// stringify identically collapse to one.
function uniqueCategories(categories: unknown[]): string[] {
  return [...new Set(categories.map(String))];
}

class JsonParseError extends Error {}

// Thrown by verifyNodeIdentity()/verifyLauncherIdentity() below for every
// way the POST /identity callback can fail -- unreachable, timed out, a
// non-2xx status, an unparseable body, a mismatched nonce, or a
// malformed/missing required field in the answer. All of these map to the
// same 502 status (this project's established convention: a downstream
// dependency failing, not the caller's own request being malformed), but
// with a message naming which one actually happened -- see this class's
// call sites in the two register routes.
class IdentityVerificationError extends Error {}

// A specific IdentityVerificationError: the fetch to POST /identity did
// not even get a response -- the endpoint refused the connection, isn't
// speaking HTTP at all (e.g. a raw swarm-rpc-server), or otherwise never
// answered. Distinguished from every other verification failure (a real
// HTTP server that answered but with a bad status/body/nonce/mismatch)
// because it is the ONLY signal /nodes/register's compute-contributor
// fallback may act on -- see that route's own comment for why a non-2xx
// response must NOT get the same leniency.
class UnreachableEndpointError extends IdentityVerificationError {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new JsonParseError("request body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

// Rejects a 401 with the RFC 7235 section 3.1 MUST: a 401 response has to
// carry a WWW-Authenticate header naming the scheme the client should use.
// Kept in one helper so every 401 this server emits is identical.
function sendUnauthorized(res: ServerResponse): void {
  const payload = JSON.stringify({ error: "missing or invalid Authorization header" });
  res.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": "Bearer",
  });
  res.end(payload);
}

function isAuthorized(req: IncomingMessage, authToken: string): boolean {
  // Node keeps the FIRST Authorization header when a request sends several
  // (core/src/http_server.cpp matches this deliberately -- see its
  // first-occurrence-wins comment), so both hops judge such a request alike.
  const header = req.headers.authorization;
  // The scheme match is case-SENSITIVE ("Bearer ", not "bearer "), which is
  // deliberately stricter than RFC 7235, where the auth-scheme token is
  // case-insensitive. Fail-closed, and identical to isAuthorized() in
  // core/src/node_agent_main.cpp so the coordinator and the node agent can
  // never disagree about whether a given request is authorized. Not an
  // oversight.
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(authToken);
  // timingSafeEqual throws on mismatched lengths rather than returning
  // false -- checking length first is fine (it doesn't leak anything
  // about the token's *content*, only its fixed, publicly-known length),
  // it's the byte-by-byte comparison that must be constant-time.
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}

const CLASSIFY_TIMEOUT_MS = 2000;
const DEFAULT_N_PREDICT = 64;
const MAX_N_PREDICT = 512;
const GENERATE_TIMEOUT_MS = 120000;
const IDENTITY_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("classifier timed out")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

const IDENTITY_RESPONSE_MAX_BYTES = 4096;

// Reads and parses an /identity response body with a hard size cap.
// Whole-branch review, Minor finding, fixed here: `res.json()` alone has
// no size limit, so a registrant-controlled endpoint returning an
// arbitrarily large body (live-verified: 120MB, buffered in full,
// registration still succeeded) could be repeated concurrently by any
// token-holder with nothing else bounding it -- IDENTITY_TIMEOUT_MS
// bounds time, not bytes. A real /identity answer is a handful of short
// fields; 4KB is generous headroom, not a tight fit.
async function readIdentityResponseJson(res: Response, endpoint: string): Promise<Record<string, unknown>> {
  const reader = res.body?.getReader();
  if (!reader) {
    throw new IdentityVerificationError(`${endpoint}/identity returned no readable body -- registration could not be verified`);
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > IDENTITY_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new IdentityVerificationError(`${endpoint}/identity response exceeded ${IDENTITY_RESPONSE_MAX_BYTES} bytes -- registration could not be verified`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof IdentityVerificationError) {
      throw err;
    }
    throw new IdentityVerificationError(`${endpoint}/identity response could not be read -- registration could not be verified`);
  }
  const text = Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf-8");
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new IdentityVerificationError(`${endpoint}/identity did not return valid JSON -- registration could not be verified`);
  }
}

// Endpoint Identity Hardening: verifies a POST /nodes/register request by
// asking the endpoint itself what it serves, rather than trusting the
// caller's claim. A single-use nonce (regenerated on every call, never
// reused) is what proves this specific response came from a live
// round-trip to this endpoint right now, not a cached, forged, or replayed
// one. Only deviceTier/servesModel come from here -- localityGroup and
// availableMemoryMb stay caller-supplied and unverified (the agent has no
// notion of either), matching the design doc's own per-field table.
//
// Deliberately NOT used for the launcher-spawned internal driver
// registrations in assemblePipeline()/tryAssemble(). Fourth whole-branch
// review, Minor finding, corrected here: this used to justify the
// omission by claiming the freshly-spawned agent "may not be listening
// yet" -- false. POST /pipeline (core/src/launcher_main.cpp) only ever
// returns success AFTER its own waitForAgentHealthy() confirms the agent
// is healthy, so by the time assemblePipeline()/tryAssemble() reach their
// registration step, the agent is provably up. The real reason this call
// is skipped: deviceTier/servesModel for this one registration are not an
// untrusted caller's claims needing verification in the first place --
// deviceTier is hardcoded "desktop" (a launcher is inherently a
// non-mobile, process-spawning machine, see the registration call site's
// own comment) and servesModel is the modelId the coordinator itself just
// requested via this same POST /pipeline call, which the launcher passed
// to the spawned agent as `--serves-model` (core/src/launcher_main.cpp).
// Calling /identity here would only re-confirm, at the cost of one more
// network round-trip per assembly, facts the coordinator already
// established by driving the spawn itself -- unlike the public route
// below, where the endpoint's claim is the ONLY thing the coordinator
// knows about it. Only the PUBLIC POST /nodes/register route (an operator
// registering a node they claim already exists) calls this.
//
// Also deliberately NOT called at all when the caller's request has no
// servesModel claim -- see this function's own call site for why (a real,
// documented registration shape, the raw swarm-rpc-server compute
// contributor, has categorically no HTTP identity route to answer this).
//
// `claimedServesModel` is the CALLER's own claim, if any. Whole-branch
// review, Critical finding, fixed here: this used to be silently
// discarded and replaced with whatever the endpoint reported (including
// nothing at all), which meant an agent started without --serves-model
// registered successfully, showed up in GET /nodes, and even showed
// available:true in GET /catalog -- yet could never actually be routed
// to, with no error anywhere explaining why (live-reproduced: the
// project's own generate_e2e.ts test, which spawns a real agent without
// --serves-model, failed this way). A claimed model the endpoint does not
// confirm is now a verification FAILURE, not a silent downgrade to
// "serves nothing" -- loud and immediate, at registration time, instead
// of a confusing 503 on every later /generate call for that model.
async function verifyNodeIdentity(endpoint: string, authToken: string, catalog: ModelCatalog, claimedServesModel: string | undefined): Promise<{ deviceTier: DeviceTier; servesModel?: string }> {
  const nonce = randomUUID();
  let res: Response;
  try {
    res = await fetch(`${endpoint}/identity`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ nonce }),
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new UnreachableEndpointError(
      `could not reach ${endpoint}/identity to verify this registration: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    // Deliberately the base IdentityVerificationError, not
    // UnreachableEndpointError: a non-2xx status means a real HTTP server
    // answered -- e.g. a genuine 404 from an old-shaped swarm-node-agent
    // that predates this route -- which is a different fact than "nothing
    // is speaking HTTP here at all". Only the latter is eligible for
    // /nodes/register's compute-contributor fallback below.
    throw new IdentityVerificationError(`${endpoint}/identity responded with status ${res.status} -- registration could not be verified`);
  }
  const candidate = await readIdentityResponseJson(res, endpoint);
  if (candidate.nonce !== nonce) {
    throw new IdentityVerificationError(`${endpoint}/identity returned a mismatched nonce -- registration could not be verified`);
  }
  if (typeof candidate.deviceTier !== "string" || !VALID_DEVICE_TIERS.includes(candidate.deviceTier as DeviceTier)) {
    throw new IdentityVerificationError(`${endpoint}/identity did not report a valid deviceTier`);
  }
  // A servesModel the agent reports but this coordinator's catalog doesn't
  // recognise is treated as "doesn't serve anything (yet)" rather than
  // failing the whole registration -- an agent's config drifting from this
  // coordinator's catalog is an operational mismatch to route around, not
  // a reason to make the node entirely unregisterable. This leniency only
  // applies when the CALLER made no claim of its own (see below for what
  // happens when they did).
  const rawReportedServesModel = typeof candidate.servesModel === "string" ? candidate.servesModel : undefined;
  const reportedServesModel = rawReportedServesModel !== undefined && catalog.hasModel(rawReportedServesModel)
    ? rawReportedServesModel
    : undefined;
  if (claimedServesModel !== undefined && claimedServesModel !== reportedServesModel) {
    // The caller asserted a specific model; the endpoint's own answer does
    // not confirm it (wrong model, an unrecognised one, or none at all --
    // e.g. an agent started without --serves-model). Reject loudly here
    // rather than silently registering a node that will look perfectly
    // healthy in GET /nodes/GET /catalog forever while never being
    // routable for the model the caller actually wanted it registered
    // for. The message reports the RAW value the endpoint sent, not the
    // catalog-filtered `reportedServesModel` -- Whole-branch review,
    // Minor finding: an operator diagnosing why their agent's real
    // --serves-model value isn't taking effect (e.g. a catalog id typo,
    // or the coordinator's catalog genuinely not knowing that model yet)
    // needs to see what the agent ACTUALLY said, not "undefined" for
    // every unrecognised value indiscriminately.
    throw new IdentityVerificationError(
      `${endpoint}/identity reported servesModel ${JSON.stringify(rawReportedServesModel)}, not the claimed ${JSON.stringify(claimedServesModel)} -- registration could not be verified`);
  }
  return { deviceTier: candidate.deviceTier as DeviceTier, servesModel: reportedServesModel };
}

// Launcher counterpart of verifyNodeIdentity() above. No Authorization
// header -- matching every other outbound call this coordinator makes to
// a launcher (POST /pipeline, DELETE /pipeline): a swarm-launcher's own
// /identity route deliberately has no auth check at all (its trust
// boundary is HttpServer's 127.0.0.1-only bind), so sending one here would
// be inconsistent with how this coordinator treats every other launcher
// route. Only agentPort is confirmed -- servesModels stays caller-supplied
// and unverified, since a launcher has no fixed answer to "what do you
// serve" the way a running agent does (see design doc's per-field table).
async function verifyLauncherIdentity(endpoint: string): Promise<{ agentPort: number }> {
  const nonce = randomUUID();
  let res: Response;
  try {
    res = await fetch(`${endpoint}/identity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new IdentityVerificationError(
      `could not reach ${endpoint}/identity to verify this registration: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new IdentityVerificationError(`${endpoint}/identity responded with status ${res.status} -- registration could not be verified`);
  }
  const candidate = await readIdentityResponseJson(res, endpoint);
  if (candidate.nonce !== nonce) {
    throw new IdentityVerificationError(`${endpoint}/identity returned a mismatched nonce -- registration could not be verified`);
  }
  // Upper-bounded too (Whole-branch review, Minor finding): an
  // out-of-range port here builds an invalid URL in launcherDriverEndpoint()
  // later, which throws a TypeError canonicalizeEndpoint() never used to
  // be able to raise from caller-controlled input, surfacing as an
  // uncaught 500 on a live /generate call instead of a clean rejection here.
  if (typeof candidate.agentPort !== "number" || !Number.isInteger(candidate.agentPort) || candidate.agentPort < 1 || candidate.agentPort > 65535) {
    throw new IdentityVerificationError(`${endpoint}/identity did not report a valid agentPort`);
  }
  return { agentPort: candidate.agentPort };
}

async function fetchPeerCapacity(endpoint: string, authToken: string): Promise<number> {
  try {
    // Same reasoning as POST /generate's outbound fetch to a node agent:
    // the coordinator is itself a client of the peer here, not just a
    // server to the outside world, and now that GET /capacity requires a
    // token, this hop needs to authenticate too. This assumes same-operator
    // federation (peers sharing one token) -- cross-operator federation
    // with differing secrets remains the open question named in the design
    // doc; a peer that rejects this token degrades gracefully below, the
    // same as an unreachable or erroring peer already did.
    const res = await fetch(`${endpoint}/capacity`, {
      headers: { authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      console.warn(`peer ${endpoint} returned non-OK status from /capacity: ${res.status}`);
      return 0;
    }
    const body = await res.json();
    return typeof body.activeNodes === "number" && Number.isFinite(body.activeNodes) && body.activeNodes >= 0
      ? body.activeNodes
      : 0;
  } catch (err) {
    console.warn(`failed to fetch capacity from peer ${endpoint}:`, err);
    return 0;
  }
}

async function federatedActiveNodeCount(registry: NodeRegistry, peers: PeerRegistry, reputation: ReputationTracker, authToken: string): Promise<number> {
  const local = registry.listActive(reputation).length;
  const peerCounts = await Promise.all(
    peers.listActive().map(peer => fetchPeerCapacity(peer.endpoint, authToken)));
  return local + peerCounts.reduce((sum, n) => sum + n, 0);
}

// Ranks candidates serving `modelId` by ReputationTracker.score() and
// returns the highest-scoring one. Ties (most commonly: several untested
// nodes, which all score the neutral 0.5) are broken by picking uniformly
// at random among the tied set, so equally-trusted nodes share load
// instead of one perpetually winning by registration order. `random` is
// injected (mirroring NodeRegistry's injectable `clock`) so callers can
// pin the tie-break for deterministic tests; it is never invoked when
// there's a unique highest scorer.
export function selectNode(nodes: NodeInfo[], reputation: ReputationTracker, modelId: string, random: () => number): NodeInfo | undefined {
  const candidates = nodes.filter(n => n.servesModel === modelId);
  if (candidates.length === 0) {
    return undefined;
  }
  let bestScore = -Infinity;
  let best: NodeInfo[] = [];
  for (const node of candidates) {
    const s = reputation.score(node.nodeId);
    if (s > bestScore) {
      bestScore = s;
      best = [node];
    } else if (s === bestScore) {
      best.push(node);
    }
  }
  return best.length === 1 ? best[0] : best[Math.floor(random() * best.length)];
}

const PIPELINE_ASSEMBLY_TIMEOUT_MS = 60000;

// Ensures a warm, HTTP-reachable pipeline exists for `modelId` before
// /generate's existing selectNode() step runs, for any model whose
// catalog entry declares requiredNodeCount > 1. A no-op for every other
// model -- returns immediately without touching PipelineTracker/
// LauncherRegistry/pipeline_selector.ts at all, so /generate's existing
// behavior for every model in today's real catalog (all requiredNodeCount
// 1, whether by explicit value or the default) is completely unaffected.
// Never throws -- any failure just means selectNode() below finds nothing
// new, falling back to whatever's already manually registered, exactly
// like today's Phase A behavior.
// Dedup wrapper around assemblePipeline(). Concurrent /generate requests
// for the same cold model all reach this at once; without serialising
// them, each independently saw an empty pool, each computed the SAME
// launcher as unclaimed (nothing is recorded until assembly returns), and
// each appended its own entry -- 10 parallel requests produced 10 pool
// entries sharing one launcherId AND one driverNodeId (the driver
// endpoint is launcherHost:agentPort, so sha256(endpoint) collides by
// construction). That inflated currentCount until the pool manager
// believed the model was fully provisioned and stopped allocating, and
// left phantom "warm" entries pointing at an agent a single teardown had
// already killed -- a 502 / markFailed / DELETE loop that ate real user
// requests. Callers that arrive mid-assembly await the in-flight attempt
// instead of starting a competing one.
function ensurePipelineReady(
  modelId: string,
  catalog: ModelCatalog,
  registry: NodeRegistry,
  reputation: ReputationTracker,
  launcherRegistry: LauncherRegistry,
  pipelineTracker: PipelineTracker,
  authToken: string,
  random: () => number,
  inFlight: Map<string, Promise<void>>,
): Promise<void> {
  const existing = inFlight.get(modelId);
  if (existing) {
    return existing;
  }
  const attempt = assemblePipeline(modelId, catalog, registry, reputation, launcherRegistry, pipelineTracker, authToken, random)
    .finally(() => inFlight.delete(modelId));
  inFlight.set(modelId, attempt);
  return attempt;
}

async function assemblePipeline(
  modelId: string,
  catalog: ModelCatalog,
  registry: NodeRegistry,
  reputation: ReputationTracker,
  launcherRegistry: LauncherRegistry,
  pipelineTracker: PipelineTracker,
  authToken: string,
  random: () => number,
): Promise<void> {
  const requiredNodeCount = catalog.requiredNodeCount(modelId);
  if (requiredNodeCount <= 1) {
    return;
  }

  // The pool can hold several entries here -- the background pool manager
  // grows it, and this cold-start path runs whenever no entry is USABLE,
  // which a multi-entry pool reaches routinely. pool[0] is therefore "the
  // entry this call may replace", not "the only entry that can exist".
  const pool = pipelineTracker.getPool(modelId);

  // The background pool manager holds an "assembling" reservation across
  // its own POST /pipeline call. Its launcher is already committed, and a
  // driver is imminent -- claiming another launcher here would race it, and
  // treating the reservation as a replaceable stale entry would tear down
  // an assembly still in flight. Fall through to whatever is already
  // registered instead, exactly as this path does when no launcher is free.
  if (pool.some(entry => entry.state === "assembling")) {
    return;
  }

  const tracked = pool[0];
  if (tracked?.state === "warm") {
    const driverStillActive = registry.listActive(reputation).some(n => n.nodeId === tracked.driverNodeId);
    if (driverStillActive) {
      // A launcher-spawned driver never self-registers/self-heartbeats
      // with the coordinator the way an operator-run swarm-node-agent can
      // (nothing external pings it), and /generate's own forwarding call
      // below doesn't touch NodeRegistry either -- so without this, a
      // perfectly healthy driver ages out of listActive() exactly
      // registry.ts's 30s timeoutMs after its one-time registration call
      // in the try block below, forcing a full, unnecessary teardown/
      // respawn/model-reload cycle on whatever request happens to land
      // just after that timer fires. Heartbeating here, on every request
      // that finds the driver still warm, keeps a genuinely healthy
      // pipeline alive indefinitely.
      //
      // This heartbeat is unconditional on presence in listActive(), not
      // on the driver actually completing anything -- listActive() only
      // reflects registration recency, never liveness. If the underlying
      // agent process has actually died, this line still fires (the
      // driver is still "active" by timestamp), and this request's own
      // /complete fetch further down still correctly answers the caller
      // with the existing 502 handling -- but that alone would leave the
      // tracked pipeline "warm" regardless, so the NEXT request for this
      // model would find the same dead driver here again, heartbeat it
      // again, and route back to it again, forever, as long as requests
      // keep arriving faster than the 30s timeout. That gap is closed
      // below, not here: /generate's own forwarding logic calls
      // pipelineTracker.markEntryFailed(modelId, ...) whenever a forward to
      // this tracked driver fails, which is what actually evicts a dead
      // driver from "warm" so the next request reassembles through the
      // launcher instead of retrying the same corpse.
      registry.heartbeat(tracked.driverNodeId);
      return;
    }
  }

  // Not findForModel() ("the first active launcher serving this model"):
  // that has no notion of whether the launcher it hands back is already
  // hosting somebody else's live pipeline, and a swarm-launcher
  // supervises exactly one agent at a time across the whole catalog. See
  // claimedLauncherIds()'s own comment for what claiming a busy one
  // actually destroys. `tracked` is excluded from the tally because it is
  // precisely the dead entry this call is about to replace -- its
  // launcher is genuinely free, and re-using it is what Phase B already
  // did for a stale pipeline.
  // Never grow the pool past the model's configured ceiling. Replacing
  // `tracked` is net-neutral (it is removed below), so it is excluded from
  // the tally; adding alongside a full pool is what must be refused. The
  // background pool manager already respected maxPipelines -- this path
  // never consulted it at all.
  if (pool.length - (tracked ? 1 : 0) >= catalog.maxPipelines(modelId)) {
    return;
  }

  const claimed = claimedLauncherIds(catalog, pipelineTracker, tracked);
  const launcher = launcherRegistry.listForModel(modelId).find(l => !isLauncherClaimed(claimed, l));
  if (!launcher) {
    return;
  }

  // selectPipeline requires requiredNodeCount total candidates already in
  // the active pool (see pipeline_selector.ts) -- this is a readiness gate
  // ("does the swarm have enough already-registered capacity to justify
  // spawning a driver at all"), not a literal reservation of a specific
  // node to become that driver. The driver itself doesn't come from this
  // selection: it's whichever fresh swarm-node-agent the launcher spawns,
  // reachable at (launcher's own host, launcher's registered agentPort).
  // selection.driver is deliberately unused below for that reason --
  // only selection.computeContributors (the machines the freshly-spawned
  // driver will shard across via --remote) feeds into the launcher call.
  const selection = selectPipeline(registry.listActive(reputation), reputation, requiredNodeCount, random);
  if (!selection) {
    return;
  }

  // Same pre-flight check the background loop does: a launcher-spawned
  // driver's endpoint is fully determined by the launcher, and nodeId is
  // derived from that endpoint's CANONICAL identity key, so a
  // reputation-ejected driver inherits the ejection on every respawn.
  // Without this the request path respawned it on EVERY /generate -- a
  // real multi-GB model load and kill per request, higher-frequency than
  // the background loop this guard was first added to.
  //
  // Computed once and reused below at actual registration time -- both
  // MUST agree on this driver's identity, and canonicalizing twice would
  // also mean two DNS lookups per assembly attempt for no benefit.
  const driverEndpoint = launcherDriverEndpoint(launcher);
  const driverIdentityKey = await canonicalizeEndpoint(driverEndpoint);
  const prospectiveDriverId = stableNodeId(driverIdentityKey);
  if (!reputation.isTrusted(prospectiveDriverId)) {
    console.warn(`skipping launcher ${launcher.endpoint} for model ${modelId}: the driver it would spawn is reputation-ejected`);
    return;
  }

  // Reserve the launcher BEFORE the network call, mirroring the background
  // loop's tryAssemble(). Without this, THIS path recorded nothing until
  // its fetch returned, so for the whole assembly window the launcher was
  // invisible to claimedLauncherIds() -- and a concurrent cold start for a
  // DIFFERENT model (the dedup Map is keyed by modelId, so it does not
  // serialise them) or a background tick would claim the same launcher. A
  // swarm-launcher supervises one agent at a time, so both models ended up
  // with a warm entry naming one launcher and one driverNodeId, and a user
  // asking for model A was served model B's weights with a 200.
  const reservationId = randomUUID();
  pipelineTracker.addEntry(modelId, {
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
    // swarm-node-agent's --remote takes host:port, not a full URL --
    // strip any scheme the registered endpoint carries.
    const toHostPort = (endpoint: string) => endpoint.replace(/^https?:\/\//, "");
    const remoteEndpoints = selection.computeContributors.map(n => toHostPort(n.endpoint)).join(",");
    // This plan doesn't need to know the model's real layer count: passing
    // zero --layer-placement flags (an empty string here) is already
    // valid -- InferenceEngine's existing automatic placement takes over,
    // exactly as it already does for every manually-configured multi-node
    // pipeline today. Explicit per-layer placement is left to a future
    // refinement, not required for this plan's own goal of proving
    // dynamic assembly works.
    const layerPlacements = "";

    const launcherRes = await fetch(`${launcher.endpoint}/pipeline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelId, remoteEndpoints, layerPlacements }),
      signal: AbortSignal.timeout(PIPELINE_ASSEMBLY_TIMEOUT_MS),
    });
    if (!launcherRes.ok) {
      pipelineTracker.removeEntry(modelId, reservationId);
      if (tracked) {
        pipelineTracker.markEntryFailed(modelId, tracked.pipelineId);
      }
      return;
    }

    // The launcher's own machine is the driver's machine -- constructed
    // from the launcher's registered host and its fixed --agent-port,
    // never from anything in `selection` (see the comment above). A
    // launcher is inherently a process-spawning, non-mobile machine, so
    // "desktop" is the correct deviceTier for the driver it just spawned
    // regardless of what deviceTier any candidate in `selection` reported
    // for itself; the launcher doesn't advertise a localityGroup of its
    // own (LauncherInfo has none), so the fresh driver registers without
    // one too.
    // driverEndpoint/driverIdentityKey were already computed above for the
    // preflight trust check -- reused here, not rebuilt, so this
    // registration can never derive a different identity than the one
    // that was actually checked.
    assertDriverIdentityFree(registry, driverIdentityKey, driverEndpoint);
    const driverNodeId = registry.register(driverEndpoint, driverIdentityKey, "desktop", undefined, modelId);
    // Replace whatever was tracked before with the freshly-assembled
    // pipeline rather than appending alongside a stale one. When the
    // replacement landed on a DIFFERENT launcher, the old one's agent must
    // actually be stopped: dropping the entry alone frees the launcherId
    // for reallocation while its agent keeps running, holding the agent
    // port and the model's weights until some unrelated model happens to
    // claim it. (Same launcher needs no call -- POST /pipeline already
    // replaced that agent in place.)
    if (tracked) {
      if (tracked.launcherId !== launcher.launcherId) {
        await stopLauncherPipeline(launcherRegistry, tracked.launcherId, tracked.launcherEndpoint);
      }
      pipelineTracker.removeEntry(modelId, tracked.pipelineId);
    }
    // Swap the reservation for the real entry: same launcher, so the claim
    // is continuous and never briefly drops.
    pipelineTracker.removeEntry(modelId, reservationId);
    pipelineTracker.addEntry(modelId, {
      pipelineId: randomUUID(),
      driverNodeId,
      computeNodeIds: selection.computeContributors.map(n => n.nodeId),
      launcherId: launcher.launcherId,
      launcherEndpoint: launcher.endpoint,
      launcherIdentityKey: launcher.identityKey,
      state: "warm",
      lastUsedAt: Date.now(),
    });
  } catch (err) {
    console.warn(`failed to assemble pipeline for model ${modelId} via launcher ${launcher.endpoint}:`, err);
    if (err instanceof DriverIdentityCollisionError) {
      // Fourth whole-branch review, Important finding, fixed here:
      // assertDriverIdentityFree() (see its own comment) only throws AFTER
      // POST /pipeline already returned success -- the launcher genuinely
      // spawned a real agent, loading real weights into RAM and holding
      // the launcher's fixed agent port, before this registration was
      // refused. Without this call that agent was orphaned: never
      // registered anywhere, never torn down, and the reconciliation loop
      // (and any other cold-start attempt) would keep finding this same
      // launcher "idle" and keep respawning over it -- live-verified to
      // spawn a fresh real agent on every single reconciliation tick
      // forever while the squat persists, strictly worse in resource terms
      // than doing nothing. Tearing it down here matches the success
      // path's own handling a few lines up (replacing a DIFFERENT
      // launcher's still-running agent already calls this same helper).
      //
      // Fifth whole-branch review, Important finding, fixed here too:
      // this used to `await` the teardown directly on the request path --
      // live-measured to stall the CALLER's already-failing /generate
      // request by however long the launcher's DELETE /pipeline takes (up
      // to PIPELINE_ASSEMBLY_TIMEOUT_MS, the same bound as the POST that
      // spawned it), for a cleanup operation that has nothing to do with
      // this caller. Detached instead: the reservation entry is kept in
      // the tracker (not removed) for exactly as long as the real teardown
      // takes, so claimedLauncherIds() keeps correctly treating this
      // launcher as busy in the meantime -- stopLauncherPipeline()'s own
      // comment states the rule this now follows: never free a launcherId
      // while its old agent might still be running. removeEntry() only
      // runs once the teardown has actually settled (stopLauncherPipeline
      // swallows its own fetch errors, so this can't reject), not before
      // it as the previous ordering did -- reversing which order the two
      // calls happened in was itself an inconsistency review found: a
      // second, concurrent assembly attempt could see this launcher freed
      // (removeEntry already ran) before the real DELETE had landed.
      void stopLauncherPipeline(launcherRegistry, launcher.launcherId, launcher.endpoint)
        .finally(() => pipelineTracker.removeEntry(modelId, reservationId));
    } else {
      pipelineTracker.removeEntry(modelId, reservationId);
    }
    if (tracked) {
      pipelineTracker.markEntryFailed(modelId, tracked.pipelineId);
    }
  }
}

export function createServer(registry: NodeRegistry, catalog: ModelCatalog, peers: PeerRegistry, classifier: SafetyClassifier, reputation: ReputationTracker, authToken: string, random: () => number = Math.random, launcherRegistry: LauncherRegistry = new LauncherRegistry(), pipelineTracker: PipelineTracker = new PipelineTracker(), demandTracker: DemandTracker = new DemandTracker()) {
  // Per-server, keyed by modelId: the cold-start assembly currently in
  // flight for that model, if any. Lives here rather than module scope so
  // two servers in one process (the test suite runs many) never share it.
  const coldStartsInFlight = new Map<string, Promise<void>>();
  return createHttpServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);

      // These four are the only routes reachable with no token: the static
      // dashboard shell (you need to load the page before you have
      // anywhere to paste a token into) and the OpenAPI document (a fixed
      // API schema, not live swarm data -- a developer needs to be able to
      // read it to find out a token is even required).
      const isPublicRoute =
        (method === "GET" && parts.length === 0) ||
        (method === "GET" && parts.length === 1 &&
          (parts[0] === "app.js" || parts[0] === "style.css" || parts[0] === "openapi.json"));

      if (!isPublicRoute && !isAuthorized(req, authToken)) {
        sendUnauthorized(res);
        return;
      }

      if (method === "POST" && parts[0] === "nodes" && parts.length === 2 && parts[1] === "register") {
        const body = await readJsonBody(req);
        if (typeof body !== "object" || body === null) {
          sendJson(res, 400, { error: "request body must be a JSON object" });
          return;
        }
        const candidate = body as Record<string, unknown>;
        if (typeof candidate.endpoint !== "string" || candidate.endpoint.length === 0) {
          sendJson(res, 400, { error: "endpoint must be a non-empty string" });
          return;
        }
        let parsedNodeEndpoint: URL;
        try {
          parsedNodeEndpoint = new URL(candidate.endpoint);
        } catch {
          sendJson(res, 400, { error: "endpoint must be a valid URL" });
          return;
        }
        if (parsedNodeEndpoint.protocol !== "http:" && parsedNodeEndpoint.protocol !== "https:") {
          sendJson(res, 400, { error: "endpoint must use http or https" });
          return;
        }
        // Normalize away a trailing slash, same reasoning as POST
        // /peers/register below: POST /generate builds outbound URLs as
        // `${node.endpoint}/complete`, and an unnormalized trailing slash
        // would produce a malformed `...//complete` request that silently
        // fails at generate-time instead of being caught here at
        // registration time.
        const normalizedNodeEndpoint = parsedNodeEndpoint.href.replace(/\/$/, "");
        if (typeof candidate.deviceTier !== "string" || !VALID_DEVICE_TIERS.includes(candidate.deviceTier as DeviceTier)) {
          sendJson(res, 400, { error: "deviceTier must be one of: desktop, android, ios" });
          return;
        }
        let localityGroup: string | undefined;
        if (candidate.localityGroup !== undefined) {
          if (typeof candidate.localityGroup !== "string" || candidate.localityGroup.length === 0) {
            sendJson(res, 400, { error: "localityGroup must be a non-empty string when provided" });
            return;
          }
          localityGroup = candidate.localityGroup;
        }
        let servesModel: string | undefined;
        if (candidate.servesModel !== undefined) {
          if (typeof candidate.servesModel !== "string" || !catalog.hasModel(candidate.servesModel)) {
            sendJson(res, 400, { error: "servesModel must be a known catalog model id when provided" });
            return;
          }
          servesModel = candidate.servesModel;
        }
        let availableMemoryMb: number | undefined;
        if (candidate.availableMemoryMb !== undefined) {
          if (typeof candidate.availableMemoryMb !== "number" || !Number.isFinite(candidate.availableMemoryMb) || candidate.availableMemoryMb < 0) {
            sendJson(res, 400, { error: "availableMemoryMb must be a non-negative number when provided" });
            return;
          }
          availableMemoryMb = candidate.availableMemoryMb;
        }
        const identityKey = await canonicalizeEndpoint(normalizedNodeEndpoint);
        // Endpoint Identity Hardening: everything above this line validates
        // the CALLER's request shape, unchanged from before this phase --
        // still 400 on a malformed body.
        //
        // Second whole-branch review, Critical finding, fixed here: the
        // FIRST fix round pinned an existing identity's `endpoint` against
        // a colliding registration, but never stopped a COLLIDING
        // registration (a different endpoint string, same canonical
        // identity) from reaching verifyNodeIdentity()/registry.register()
        // at all. That call verifies whatever endpoint the CALLER
        // submitted -- which, on a collision, is NOT the endpoint the
        // pinned entry actually points at -- and then writes the result
        // onto the PINNED entry regardless. Live-verified before this fix:
        // an attacker pre-registers a placeholder under an alias of a
        // victim's identity (e.g. the victim's real agent will later use
        // 127.0.0.1, the attacker registers [::1] first), pinning their
        // OWN endpoint. The victim's own later, genuinely-successful,
        // correctly-verified registration then has ITS verified
        // deviceTier/servesModel written onto the ATTACKER's pinned
        // endpoint -- /generate keeps routing to the attacker, who
        // captures real prompts, and the victim's own repeated
        // registrations report 200 forever with no error. Verifying the
        // submitted endpoint can only ever establish facts about THAT
        // endpoint; it establishes nothing about a DIFFERENT one a prior
        // registration happened to pin. The only safe rule, absent a
        // proof-of-endpoint-possession mechanism (explicitly out of scope
        // -- see the design doc's Non-Goals): a registration whose
        // endpoint does not match an already-ACTIVE entry for the same
        // identity is rejected outright, loudly, naming the pinned
        // endpoint -- never silently absorbed. This does not prevent a
        // squatter from claiming an identity FIRST (a disclosed residual,
        // matching this phase's already-accepted non-goals), but it turns
        // that into a loud, diagnosable registration conflict instead of a
        // silent security breach: the legitimate owner gets a 409 naming
        // exactly what's pinned, rather than a 200 that quietly routes
        // their traffic elsewhere.
        const identityNodeId = stableNodeId(identityKey);
        const pinnedEndpoint = registry.listActive().find(n => n.nodeId === identityNodeId)?.endpoint;
        if (pinnedEndpoint !== undefined && pinnedEndpoint !== normalizedNodeEndpoint) {
          sendJson(res, 409, {
            error: `this identity is already registered under a different endpoint (${pinnedEndpoint}) -- registration refused rather than silently reassigning it`,
          });
          return;
        }
        // Second whole-branch review, Critical finding, fixed here too:
        // verification used to be SKIPPED whenever the caller claimed no
        // servesModel, based purely on the shape of THIS request -- so a
        // real agent that DOES serve a model, started correctly with
        // --serves-model, still ended up registered with no servesModel
        // at all whenever the registering script simply forgot to repeat
        // the claim, permanently unroutable with no error anywhere
        // (live-reproduced as a regression this branch's own prior fix
        // introduced). Verification is now ALWAYS attempted regardless of
        // what the caller claims; the compute-contributor exemption is
        // decided from the OUTCOME instead -- only a genuine
        // UnreachableEndpointError (the endpoint isn't speaking HTTP at
        // all, e.g. a raw swarm-rpc-server) falls back to the caller's
        // bare claim, and only when nothing already-verified is at stake
        // for this identity (an existing verified servesModel is not
        // silently cleared by a transient blip -- that registration is
        // rejected instead, disclosed as a narrow residual rather than
        // engineered around further). A non-2xx response (e.g. a genuine
        // 404 from an old-shaped agent that predates this route) is a
        // real HTTP server answering, not "no HTTP identity here at all",
        // so it does NOT get this leniency -- see verifyNodeIdentity()'s
        // own comment for why that distinction matters.
        const existingServesModel = registry.listActive().find(n => n.nodeId === identityNodeId)?.servesModel;
        let resolvedDeviceTier: DeviceTier;
        let resolvedServesModel: string | undefined;
        let usedUnreachableFallback = false;
        try {
          const verified = await verifyNodeIdentity(normalizedNodeEndpoint, authToken, catalog, servesModel);
          resolvedDeviceTier = verified.deviceTier;
          resolvedServesModel = verified.servesModel;
        } catch (err) {
          if (err instanceof UnreachableEndpointError && servesModel === undefined && existingServesModel === undefined) {
            resolvedDeviceTier = candidate.deviceTier as DeviceTier;
            resolvedServesModel = undefined;
            usedUnreachableFallback = true;
          } else {
            sendJson(res, 502, { error: err instanceof IdentityVerificationError ? err.message : "failed to verify this registration" });
            return;
          }
        }
        // Third whole-branch review, Critical finding, fixed here: the
        // check above happens BEFORE the `await verifyNodeIdentity()` a few
        // lines up -- a genuine TOCTOU window, up to IDENTITY_TIMEOUT_MS
        // wide (an attacker can widen it further by stalling their own
        // /identity response), during which a second, colliding
        // registration can run this whole handler concurrently and commit
        // first. Live-verified: with two callers racing a colliding
        // identity, the loser's check above still read "nothing pinned yet"
        // and sailed through to here, silently reproducing both of round
        // 2's fixed bugs (a real agent's servesModel silently stripped; a
        // victim's honest, verified registration written onto an
        // attacker's endpoint, capturing real prompts) even with the first
        // check in place -- 4 of 10 concurrent colliding registrations were
        // silently absorbed per burst in testing. Re-reading the pinned
        // endpoint here, synchronously, with no `await` between this check
        // and registry.register() below, closes the window completely: two
        // requests can still both pass the FIRST check (nothing pinned
        // yet), but only one of them can ever reach this second check
        // before the other's register() call has already committed, and
        // Node's single-threaded event loop guarantees nothing can run
        // between this check and that commit to reopen the gap.
        const pinnedEndpointAtCommit = registry.listActive().find(n => n.nodeId === identityNodeId)?.endpoint;
        if (pinnedEndpointAtCommit !== undefined && pinnedEndpointAtCommit !== normalizedNodeEndpoint) {
          sendJson(res, 409, {
            error: `this identity is already registered under a different endpoint (${pinnedEndpointAtCommit}) -- registration refused rather than silently reassigning it`,
          });
          return;
        }
        // Fourth whole-branch review, Critical finding, fixed here: round
        // 3's re-check above closed the TOCTOU for the PINNED ENDPOINT, but
        // `existingServesModel` a few lines up has the exact same shape --
        // read BEFORE `await verifyNodeIdentity()`, used AFTER it, with
        // nothing re-confirming it's still current at commit time. This
        // reopens round 2's Critical (a real, verified servesModel silently
        // stripped) whenever two registrations for the SAME endpoint race:
        // this project's own agent is single-threaded (documented above),
        // so a burst of registration calls hitting a busy agent is a
        // plausible, not contrived, way for one call's identity check to
        // outlast IDENTITY_TIMEOUT_MS while another's succeeds moments
        // earlier -- no attacker required, though one can force it by
        // occupying the agent deliberately. Live-reproduced: the loser's
        // `existingServesModel` read as undefined (nothing had committed
        // yet), so it took the compute-contributor fallback and proceeded
        // to overwrite the winner's just-committed, genuinely-verified
        // servesModel with nothing -- passing round 3's own endpoint
        // re-check trivially, since both calls target the identical
        // endpoint string (not a colliding alias), so "the same as pinned"
        // is true and that check never fires. Re-confirming here,
        // synchronously, with no `await` before registry.register() below,
        // that nothing has since committed a real servesModel for this
        // identity before allowing the fallback's result through applies
        // the same rule this file has now had to state three times: no
        // decision this handler already made may reach registry.register()
        // without being re-confirmed against the CURRENT registry state at
        // the exact point of commitment.
        // Fifth whole-branch review, Important finding, fixed here: the
        // check above only re-read `servesModel`, leaving `deviceTier`
        // exposed to the identical bug -- the fallback branch a few lines
        // up unconditionally writes `candidate.deviceTier` (the CALLER's
        // own unverified claim), with nothing stopping it from silently
        // overwriting a deviceTier an earlier registration already had
        // ENDPOINT-verified. Live-reproduced: kill an endpoint after its
        // real, verified deviceTier ("android") is on record, then have
        // any token-holder re-register the same endpoint with no
        // servesModel claim -- the fallback fires, and the entry's real
        // "android" silently became the new caller's own guessed "ios",
        // contradicting this project's own README claim that
        // endpoint-verified fields "cannot be stripped" this way. Rather
        // than re-deriving a second, narrower per-field guard (the same
        // "patch the instance, not the mechanism" mistake this file has
        // now made three times), this refuses the fallback outright
        // whenever ANY active entry already exists for this identity, not
        // only one with a servesModel -- the fallback's caller-supplied
        // claim is only ever safe to trust for a genuinely first-ever
        // registration, when there is nothing yet to protect.
        if (usedUnreachableFallback) {
          const activeAtCommit = registry.listActive().find(n => n.nodeId === identityNodeId);
          if (activeAtCommit !== undefined) {
            sendJson(res, 502, {
              error: `${normalizedNodeEndpoint} could not be reached to verify this registration, and this identity is already registered (deviceTier ${JSON.stringify(activeAtCommit.deviceTier)}${activeAtCommit.servesModel !== undefined ? `, servesModel ${JSON.stringify(activeAtCommit.servesModel)}` : ""}) -- registration refused rather than silently overwriting it with an unverified claim`,
            });
            return;
          }
        }
        const nodeId = registry.register(normalizedNodeEndpoint, identityKey, resolvedDeviceTier, localityGroup, resolvedServesModel, availableMemoryMb);
        sendJson(res, 200, { nodeId });
        return;
      }

      if (method === "POST" && parts[0] === "nodes" && parts.length === 3 && parts[2] === "heartbeat") {
        const ok = registry.heartbeat(parts[1]);
        if (!ok) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === "POST" && parts[0] === "nodes" && parts.length === 4 && parts[2] === "reputation" &&
          (parts[3] === "agree" || parts[3] === "disagree")) {
        // Existence check deliberately uses the UNFILTERED listActive() (no
        // reputation argument): a node already ejected by reputation (i.e.
        // excluded from the filtered view) is still a real, registered node,
        // and further agree/disagree events must still be recordable against
        // it. Only capacity-facing views (GET /nodes, /catalog) apply the
        // reputation filter.
        const exists = registry.listActive().some(n => n.nodeId === parts[1]);
        if (!exists) {
          res.writeHead(404);
          res.end();
          return;
        }
        if (parts[3] === "agree") {
          reputation.recordAgreement(parts[1]);
        } else {
          reputation.recordDisagreement(parts[1]);
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === "GET" && parts[0] === "nodes" && parts.length === 3 && parts[2] === "reputation") {
        const exists = registry.listActive().some(n => n.nodeId === parts[1]);
        if (!exists) {
          res.writeHead(404);
          res.end();
          return;
        }
        const stats = reputation.getStats(parts[1]);
        sendJson(res, 200, { ...stats, trusted: reputation.isTrusted(parts[1]) });
        return;
      }

      if (method === "GET" && parts[0] === "nodes" && parts.length === 1) {
        sendJson(res, 200, registry.listActive(reputation));
        return;
      }

      if (method === "GET" && parts[0] === "nodes" && parts.length === 2 && parts[1] === "locality") {
        const groups = registry.groupByLocality(reputation);
        // Object.fromEntries (not a manual loop) avoids invoking Object.prototype's
        // legacy __proto__ setter when a self-reported localityGroup is literally
        // "__proto__" (see commit 7060b00). Side effect: integer-like group names
        // sort first in the JSON output instead of preserving Map insertion order
        // — a documented own-property-ordering quirk, not a bug (JSON objects are
        // formally unordered).
        const asObject = Object.fromEntries(groups);
        sendJson(res, 200, asObject);
        return;
      }

      if (method === "GET" && parts[0] === "capacity" && parts.length === 1) {
        // Apply the reputation filter here: /capacity is polled by OTHER
        // coordinators (see fetchPeerCapacity) to build their own federated
        // active-node count, and each coordinator only holds reputation data
        // for its own directly-registered nodes. Filtering here is what
        // keeps an ejected node from silently counting toward every other
        // coordinator's federated capacity view.
        sendJson(res, 200, { activeNodes: registry.listActive(reputation).length });
        return;
      }

      if (method === "POST" && parts[0] === "peers" && parts.length === 2 && parts[1] === "register") {
        const body = await readJsonBody(req);
        if (typeof body !== "object" || body === null) {
          sendJson(res, 400, { error: "request body must be a JSON object" });
          return;
        }
        const candidate = body as Record<string, unknown>;
        if (typeof candidate.endpoint !== "string" || candidate.endpoint.length === 0) {
          sendJson(res, 400, { error: "endpoint must be a non-empty string" });
          return;
        }
        let parsedEndpoint: URL;
        try {
          parsedEndpoint = new URL(candidate.endpoint);
        } catch {
          sendJson(res, 400, { error: "endpoint must be a valid URL" });
          return;
        }
        if (parsedEndpoint.protocol !== "http:" && parsedEndpoint.protocol !== "https:") {
          sendJson(res, 400, { error: "endpoint must use http or https" });
          return;
        }
        // Normalize away a trailing slash so both dedupe (PeerRegistry.register
        // matches on exact endpoint string) and outbound capacity fetches
        // (`${endpoint}/capacity`) are built consistently -- an unnormalized
        // trailing slash would otherwise produce a malformed `...//capacity`
        // URL that silently 404s, and would let the same instance register
        // twice (with and without the slash) and double-count its capacity.
        const normalizedEndpoint = parsedEndpoint.href.replace(/\/$/, "");
        // Deliberate asymmetry with POST /nodes/register and POST
        // /launchers/register just above and below: there is no
        // endpoint-authoritative verification here, and none is added by
        // Endpoint Identity Hardening. A peer is another COORDINATOR, not a
        // swarm-node-agent/swarm-launcher -- it has no POST /identity route
        // to call, and inventing one would mean designing and securing a
        // coordinator-to-coordinator identity protocol, which is a
        // materially different problem from asking a single-purpose agent
        // what it serves. Out of scope for this phase; see README.
        const peerIdentityKey = await canonicalizeEndpoint(normalizedEndpoint);
        const peerId = peers.register(normalizedEndpoint, peerIdentityKey);
        sendJson(res, 200, { peerId });
        return;
      }

      if (method === "POST" && parts[0] === "launchers" && parts.length === 2 && parts[1] === "register") {
        const body = await readJsonBody(req);
        if (typeof body !== "object" || body === null) {
          sendJson(res, 400, { error: "request body must be a JSON object" });
          return;
        }
        const candidate = body as Record<string, unknown>;
        if (typeof candidate.endpoint !== "string" || candidate.endpoint.length === 0) {
          sendJson(res, 400, { error: "endpoint must be a non-empty string" });
          return;
        }
        let parsedLauncherEndpoint: URL;
        try {
          parsedLauncherEndpoint = new URL(candidate.endpoint);
        } catch {
          sendJson(res, 400, { error: "endpoint must be a valid URL" });
          return;
        }
        if (parsedLauncherEndpoint.protocol !== "http:" && parsedLauncherEndpoint.protocol !== "https:") {
          sendJson(res, 400, { error: "endpoint must use http or https" });
          return;
        }
        // Normalize away a trailing slash, same reasoning as POST
        // /nodes/register and POST /peers/register above: Task 7 will fetch
        // this launcher's endpoint as `${launcher.endpoint}/pipeline`, and an
        // unnormalized trailing slash would produce a malformed
        // `...//pipeline` request that silently fails at pipeline-assembly
        // time instead of being caught here at registration time.
        const normalizedLauncherEndpoint = parsedLauncherEndpoint.href.replace(/\/$/, "");
        if (!Array.isArray(candidate.servesModels) || !candidate.servesModels.every(m => typeof m === "string")) {
          sendJson(res, 400, { error: "servesModels must be an array of strings" });
          return;
        }
        if (typeof candidate.agentPort !== "number" || !Number.isInteger(candidate.agentPort) || candidate.agentPort < 1 || candidate.agentPort > 65535) {
          sendJson(res, 400, { error: "agentPort must be a positive integer no greater than 65535" });
          return;
        }
        const launcherIdentityKey = await canonicalizeEndpoint(normalizedLauncherEndpoint);
        // Second whole-branch review, Minor finding, applied here too:
        // the SAME collision-rejection rule POST /nodes/register now
        // enforces (see its own, much longer comment for the full
        // reasoning and the live-verified attack it closes) -- a
        // registration whose endpoint does not match an already-ACTIVE
        // launcher entry for the same identity is rejected outright,
        // never silently absorbed. This surface is the higher-severity
        // one to get right: a launcher's POST /pipeline is this project's
        // own documented RCE-shaped surface (see the design doc's Open
        // Questions), so silently letting a colliding registration attach
        // verified-but-irrelevant fields to a squatter's pinned launcher
        // identity is a worse outcome here than for a plain node.
        const pinnedLauncherEndpoint = launcherRegistry.listActive().find(l => l.identityKey === launcherIdentityKey)?.endpoint;
        if (pinnedLauncherEndpoint !== undefined && pinnedLauncherEndpoint !== normalizedLauncherEndpoint) {
          sendJson(res, 409, {
            error: `this identity is already registered under a different endpoint (${pinnedLauncherEndpoint}) -- registration refused rather than silently reassigning it`,
          });
          return;
        }
        // Only agentPort is confirmed against the launcher itself --
        // servesModels stays exactly as the caller supplied it above,
        // unverified, since a launcher has no fixed answer to "what do you
        // serve" (see verifyLauncherIdentity()'s own comment).
        let verifiedLauncher: { agentPort: number };
        try {
          verifiedLauncher = await verifyLauncherIdentity(normalizedLauncherEndpoint);
        } catch (err) {
          sendJson(res, 502, { error: err instanceof IdentityVerificationError ? err.message : "failed to verify this registration" });
          return;
        }
        // Third whole-branch review, Critical finding, fixed here too --
        // same TOCTOU window as POST /nodes/register's own fix above (see
        // its much longer comment for the full reasoning and live
        // reproduction), between the collision check above and the
        // `await verifyLauncherIdentity()` a few lines up. Live-verified on
        // this route specifically: a fast, honest launcher registration
        // followed ~2.4s later by a slow, colliding attacker registration
        // both returned 200, with the attacker's servesModels AND
        // agentPort silently overwriting the honest launcher's entry --
        // since launcherDriverEndpoint() is host:agentPort, an
        // attacker-chosen agentPort on an otherwise-honest launcher's
        // pinned entry means the coordinator spawns a real agent on the
        // honest machine and then treats a DIFFERENT, attacker-controlled
        // port as the driver. Re-reading the pinned endpoint here,
        // synchronously, with no `await` before launcherRegistry.register()
        // below, closes the window the same way.
        const pinnedLauncherEndpointAtCommit = launcherRegistry.listActive().find(l => l.identityKey === launcherIdentityKey)?.endpoint;
        if (pinnedLauncherEndpointAtCommit !== undefined && pinnedLauncherEndpointAtCommit !== normalizedLauncherEndpoint) {
          sendJson(res, 409, {
            error: `this identity is already registered under a different endpoint (${pinnedLauncherEndpointAtCommit}) -- registration refused rather than silently reassigning it`,
          });
          return;
        }
        const launcherId = launcherRegistry.register(normalizedLauncherEndpoint, launcherIdentityKey, candidate.servesModels as string[], verifiedLauncher.agentPort);
        sendJson(res, 200, { launcherId });
        return;
      }

      if (method === "POST" && parts[0] === "launchers" && parts.length === 3 && parts[2] === "heartbeat") {
        const ok = launcherRegistry.heartbeat(parts[1]);
        if (!ok) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === "POST" && parts[0] === "peers" && parts.length === 3 && parts[2] === "heartbeat") {
        const ok = peers.heartbeat(parts[1]);
        if (!ok) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === "GET" && parts[0] === "peers" && parts.length === 1) {
        sendJson(res, 200, peers.listActive());
        return;
      }

      if (method === "DELETE" && parts[0] === "peers" && parts.length === 2) {
        const ok = peers.deregister(parts[1]);
        if (!ok) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === "GET" && parts[0] === "catalog" && parts.length === 1) {
        const activeNodeCount = await federatedActiveNodeCount(registry, peers, reputation, authToken);
        sendJson(res, 200, catalog.availability(activeNodeCount));
        return;
      }

      if (method === "POST" && parts[0] === "classify" && parts.length === 1) {
        const body = await readJsonBody(req);
        if (typeof body !== "object" || body === null) {
          sendJson(res, 400, { error: "request body must be a JSON object" });
          return;
        }
        const candidate = body as Record<string, unknown>;
        if (typeof candidate.prompt !== "string") {
          sendJson(res, 400, { error: "prompt must be a string" });
          return;
        }
        try {
          const result = await withTimeout(classifier.classify(candidate.prompt), CLASSIFY_TIMEOUT_MS);
          // Read `safe`/`categories` into local variables exactly once each,
          // validate those locals, and build the response from those SAME
          // locals -- never re-read `result` itself. If we validated
          // `result.safe`/`result.categories` and then forwarded `result`
          // by reference to sendJson, a `toJSON()` method, getter, or Proxy
          // on that object could return different values when
          // JSON.stringify re-reads it during serialization, letting a
          // validated safe:false slip out as safe:true. Re-reading the
          // property twice (once to validate, once to serialize) reopens
          // the same gap even without forwarding the object itself.
          const safe = result?.safe;
          const categories = result?.categories;
          if (typeof safe !== "boolean" || !Array.isArray(categories)) {
            throw new Error("classifier returned a malformed result");
          }
          sendJson(res, 200, { safe, categories: uniqueCategories(categories) });
        } catch {
          // Fail closed: a classifier error (including a malformed result or
          // a timeout) must never be treated as "safe".
          sendJson(res, 200, { safe: false, categories: ["classifier_error"] });
        }
        return;
      }

      if (method === "POST" && parts[0] === "generate" && parts.length === 1) {
        const body = await readJsonBody(req);
        if (typeof body !== "object" || body === null) {
          sendJson(res, 400, { error: "request body must be a JSON object" });
          return;
        }
        const candidate = body as Record<string, unknown>;

        if (typeof candidate.prompt !== "string") {
          sendJson(res, 400, { error: "prompt must be a string" });
          return;
        }
        if (typeof candidate.modelId !== "string" || !catalog.hasModel(candidate.modelId)) {
          sendJson(res, 400, { error: "modelId must be a known catalog model id" });
          return;
        }
        const stream = candidate.stream === true;
        let nPredict = DEFAULT_N_PREDICT;
        if (candidate.n_predict !== undefined) {
          if (
            typeof candidate.n_predict !== "number" ||
            !Number.isInteger(candidate.n_predict) ||
            candidate.n_predict < 1 ||
            candidate.n_predict > MAX_N_PREDICT
          ) {
            sendJson(res, 400, { error: `n_predict must be an integer between 1 and ${MAX_N_PREDICT}` });
            return;
          }
          nPredict = candidate.n_predict;
        }

        try {
          const result = await withTimeout(classifier.classify(candidate.prompt), CLASSIFY_TIMEOUT_MS);
          const safe = result?.safe;
          const categories = result?.categories;
          if (typeof safe !== "boolean" || !Array.isArray(categories)) {
            throw new Error("classifier returned a malformed result");
          }
          if (!safe) {
            sendJson(res, 400, { safe: false, categories: uniqueCategories(categories) });
            return;
          }
        } catch {
          // Fail closed, matching /classify's own established behavior: a
          // classifier error (including a malformed result or a timeout) must
          // never be treated as "safe enough to route."
          sendJson(res, 400, { safe: false, categories: ["classifier_error"] });
          return;
        }

        // Recorded here, after the safety gate and every validation
        // above, rather than at the top of the handler: demand exists to
        // tell PipelinePoolManager how much pipeline capacity real
        // traffic needs, and a request rejected for a bad modelId or a
        // blocked prompt never reaches a pipeline at all. A malformed or
        // hostile request stream must not be able to talk the pool into
        // scaling up.
        demandTracker.recordRequest(candidate.modelId);

        let selected: NodeInfo | undefined;
        // Warm entries only, and only ones whose driver is still active
        // and trusted -- listActive(reputation) is the same choke point
        // every other routing decision in this service reads through, so
        // a reputation-ejected driver drops out of the pool's reach here
        // for free, exactly as it does from selectNode() below.
        const activeById = new Map(registry.listActive(reputation).map(n => [n.nodeId, n]));
        const usable = pipelineTracker.getPool(candidate.modelId)
          .filter(entry => entry.state === "warm" && activeById.has(entry.driverNodeId));
        if (usable.length > 0) {
          // Least-recently-used selection: whichever usable entry has gone
          // longest without serving a request. Reuses the lastUsedAt field
          // PipelinePoolManager's idle-grace-period check already needs,
          // rather than adding a separate round-robin counter per model --
          // swarm-node-agent serves one request at a time anyway
          // (documented, unchanged limitation), so this spreads load just
          // as evenly as a counter would, for less state. A tie (two
          // entries stamped in the same millisecond) keeps the earlier
          // entry, which is stable rather than arbitrary.
          const entry = usable.reduce((oldest, e) => e.lastUsedAt < oldest.lastUsedAt ? e : oldest);
          entry.lastUsedAt = Date.now();
          // The same per-request heartbeat ensurePipelineReady's warm-check
          // does, and for the same reason: a launcher-spawned driver never
          // self-registers/self-heartbeats the way an operator-run
          // swarm-node-agent can, so without this it ages out of
          // listActive() exactly registry.ts's 30s timeoutMs after it was
          // registered no matter how much traffic it is successfully
          // serving, and a healthy pool tears itself down. Now that a warm
          // pool entry is served from here instead of falling through to
          // ensurePipelineReady, this line is the only thing keeping any
          // pool entry past pool[0] alive between the pool manager's own
          // 30s reconciliation ticks.
          registry.heartbeat(entry.driverNodeId);
          selected = activeById.get(entry.driverNodeId);
        }
        if (!selected) {
          // Cold-start fallback: nothing usable in the pool (empty, every
          // entry failed, or every entry's driver has dropped out of the
          // registry -- the next reconciliation tick prunes those; this
          // request doesn't wait for it). Assembles at most one pipeline
          // synchronously, exactly as Phase B's existing behavior does,
          // and is still a complete no-op for every requiredNodeCount:1
          // model.
          await ensurePipelineReady(candidate.modelId, catalog, registry, reputation, launcherRegistry, pipelineTracker, authToken, random, coldStartsInFlight);
          selected = selectNode(registry.listActive(reputation), reputation, candidate.modelId, random);
        }
        if (!selected) {
          sendJson(res, 503, { error: `no active node currently serves model "${candidate.modelId}"` });
          return;
        }
        // Rebound as a const so the markDriverFailedIfTracked closure
        // below closes over a value that provably can't be undefined or
        // reassigned, rather than over the mutable `selected` binding.
        const node = selected;

        // A forward to `node` below can fail several different ways (a
        // non-2xx status, a non-SSE content-type when stream:true was
        // requested, a malformed JSON body, or the fetch itself throwing)
        // across the streaming and non-streaming branches that follow.
        // Whenever the failing `node` is the pipeline driver
        // ensurePipelineReady is currently tracking as "warm" for this
        // model, that tracked entry must be invalidated here -- otherwise
        // the NEXT request for this model finds the same dead driver
        // still "active" (ensurePipelineReady's heartbeat only checks
        // registry presence, never liveness) and routes back to it again,
        // forever. This is a side effect only: it never changes what this
        // request sends back to the caller, which every call site below
        // still does exactly as it did before.
        const markDriverFailedIfTracked = () => {
          // Every entry naming this driver, not just the first: entries can
          // legitimately share a driverNodeId (it is sha256 of the driver
          // endpoint, and one launcher always spawns its agent on the same
          // host:agentPort), so a .find() here would evict one and leave the
          // others warm, routable, and still pointing at the dead driver.
          for (const entry of pipelineTracker.getPool(candidate.modelId)) {
            if (entry.driverNodeId === node.nodeId) {
              pipelineTracker.markEntryFailed(candidate.modelId, entry.pipelineId);
            }
          }
        };

        if (stream) {
          try {
            const nodeRes = await fetch(`${node.endpoint}/complete`, {
              method: "POST",
              headers: { "content-type": "application/json", "authorization": `Bearer ${authToken}` },
              body: JSON.stringify({ prompt: candidate.prompt, n_predict: nPredict, stream: true }),
              signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
            });
            if (!nodeRes.ok || !nodeRes.body) {
              markDriverFailedIfTracked();
              sendJson(res, 502, { error: `node returned status ${nodeRes.status}` });
              return;
            }
            const nodeContentType = (nodeRes.headers.get("content-type") ?? "").toLowerCase();
            if (!nodeContentType.startsWith("text/event-stream")) {
              // A node that doesn't understand stream:true (e.g. a
              // pre-Phase-D agent build) answers 200 application/json
              // instead of an SSE stream. Relaying that body under a
              // text/event-stream content-type would produce a
              // well-formed-looking response that silently yields zero
              // pieces to every consumer -- fail loudly instead, before
              // committing to any response headers.
              markDriverFailedIfTracked();
              sendJson(res, 502, { error: "node did not return a streaming response" });
              return;
            }
            // Raw passthrough, not decode-then-re-encode: both hops speak
            // the identical SSE dialect (this coordinator's own choice, see
            // the Phase D design doc), so the node's bytes are already
            // exactly what this response needs to send -- including any
            // "event: error" frame the node emits mid-stream, which flows
            // through unchanged.
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const reader = nodeRes.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
            res.end();
          } catch (err) {
            console.warn(`failed to forward streaming /generate to node ${node.endpoint}:`, err);
            markDriverFailedIfTracked();
            // If SSE headers haven't gone out yet, a normal error response
            // is still possible; once they have, the only safe recovery is
            // to close the connection -- a fresh 502 can't be layered onto
            // a response that already declared itself a 200 text/event-stream.
            if (!res.headersSent) {
              sendJson(res, 502, { error: "failed to reach the selected node" });
            } else {
              res.end();
            }
          }
          return;
        }

        try {
          const nodeRes = await fetch(`${node.endpoint}/complete`, {
            method: "POST",
            headers: { "content-type": "application/json", "authorization": `Bearer ${authToken}` },
            body: JSON.stringify({ prompt: candidate.prompt, n_predict: nPredict }),
            signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
          });
          if (!nodeRes.ok) {
            markDriverFailedIfTracked();
            sendJson(res, 502, { error: `node returned status ${nodeRes.status}` });
            return;
          }
          const nodeBody = await nodeRes.json();
          if (typeof nodeBody.text !== "string") {
            markDriverFailedIfTracked();
            sendJson(res, 502, { error: "node returned a malformed response" });
            return;
          }
          sendJson(res, 200, { text: nodeBody.text });
        } catch (err) {
          console.warn(`failed to forward /generate to node ${node.endpoint}:`, err);
          markDriverFailedIfTracked();
          sendJson(res, 502, { error: "failed to reach the selected node" });
        }
        return;
      }

      if (method === "GET" && parts[0] === "v1" && parts[1] === "models" && parts.length === 2) {
        // catalog.availability()'s per-entry `available` field is dropped
        // below (OpenAI's schema has no place for it -- this route lists
        // every catalog entry regardless, matching GET /catalog's own
        // never-filter-out-under-capacity-models behavior), so the
        // count it's computed from doesn't matter -- calling
        // federatedActiveNodeCount() here would pay this route's callers
        // (typically a client's model picker, polled routinely) the full
        // cost of an outbound /capacity fetch to every registered peer
        // (up to 2s each) for a number never used.
        const data = catalog.availability(0).map(entry => ({
          id: entry.id,
          object: "model" as const,
          created: 0,
          owned_by: "swarm-llm",
        }));
        sendJson(res, 200, { object: "list", data });
        return;
      }

      if (method === "POST" && parts[0] === "v1" && parts[1] === "chat" && parts[2] === "completions" && parts.length === 3) {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          // A malformed body would otherwise fall through to the shared
          // outer catch below, which answers {error: string} -- breaking
          // this route's own documented "always OpenAI's {error: {message,
          // type, code}} envelope" contract in openapi.ts. Guarded locally
          // so every 400 this route can produce keeps the same shape. Only
          // a genuine parse failure is a 400 here -- rethrow anything else
          // (e.g. the request stream itself erroring, a client disconnect
          // mid-upload) so it still reaches the outer handler's generic 500,
          // matching every other route's readJsonBody() call site instead of
          // mislabeling a connection failure as "malformed JSON".
          if (!(err instanceof JsonParseError)) {
            throw err;
          }
          sendJson(res, 400, { error: { message: "request body is not valid JSON", type: "invalid_request_error", code: null } });
          return;
        }
        if (typeof body !== "object" || body === null) {
          sendJson(res, 400, { error: { message: "request body must be a JSON object", type: "invalid_request_error", code: null } });
          return;
        }
        const candidate = body as Record<string, unknown>;

        if (typeof candidate.model !== "string" || !catalog.hasModel(candidate.model)) {
          sendJson(res, 400, { error: { message: `The model '${String(candidate.model)}' does not exist.`, type: "invalid_request_error", code: "model_not_found" } });
          return;
        }
        if (!Array.isArray(candidate.messages) || candidate.messages.length === 0) {
          sendJson(res, 400, { error: { message: "messages must be a non-empty array", type: "invalid_request_error", code: null } });
          return;
        }
        const messages: ChatMessage[] = [];
        for (const m of candidate.messages) {
          if (typeof m !== "object" || m === null) {
            sendJson(res, 400, { error: { message: "each message must be an object", type: "invalid_request_error", code: null } });
            return;
          }
          const mc = m as Record<string, unknown>;
          if (mc.role !== "system" && mc.role !== "user" && mc.role !== "assistant") {
            sendJson(res, 400, { error: { message: "each message's role must be one of: system, user, assistant", type: "invalid_request_error", code: null } });
            return;
          }
          if (typeof mc.content !== "string") {
            sendJson(res, 400, { error: { message: "each message's content must be a string", type: "invalid_request_error", code: null } });
            return;
          }
          messages.push({ role: mc.role, content: mc.content });
        }
        let maxTokens = DEFAULT_N_PREDICT;
        // Both official OpenAI SDKs type this field nullable and serialize
        // an explicit null for "unspecified" (only their own NOT_GIVEN/
        // undefined sentinel is dropped from the request body entirely) --
        // treated the same as omitted, matching stream_options below.
        if (candidate.max_tokens !== undefined && candidate.max_tokens !== null) {
          if (
            typeof candidate.max_tokens !== "number" ||
            !Number.isInteger(candidate.max_tokens) ||
            candidate.max_tokens < 1 ||
            candidate.max_tokens > MAX_N_PREDICT
          ) {
            sendJson(res, 400, { error: { message: `max_tokens must be an integer between 1 and ${MAX_N_PREDICT}`, type: "invalid_request_error", code: null } });
            return;
          }
          maxTokens = candidate.max_tokens;
        }
        const stream = candidate.stream === true;
        const includeUsageInStream =
          stream &&
          typeof candidate.stream_options === "object" &&
          candidate.stream_options !== null &&
          (candidate.stream_options as Record<string, unknown>).include_usage === true;

        const prompt = buildPromptFromMessages(messages);

        try {
          const result = await withTimeout(classifier.classify(prompt), CLASSIFY_TIMEOUT_MS);
          const safe = result?.safe;
          const categories = result?.categories;
          if (typeof safe !== "boolean" || !Array.isArray(categories)) {
            throw new Error("classifier returned a malformed result");
          }
          if (!safe) {
            const categoryList = uniqueCategories(categories);
            sendJson(res, 400, {
              error: {
                message: `Prompt blocked by safety filter (categories: ${categoryList.length > 0 ? categoryList.join(", ") : "unspecified"}).`,
                type: "invalid_request_error",
                code: null,
              },
            });
            return;
          }
        } catch {
          sendJson(res, 400, {
            error: { message: "Prompt blocked: the safety classifier failed or timed out.", type: "invalid_request_error", code: null },
          });
          return;
        }

        // Same placement and reasoning as /generate's own call: after the
        // safety gate and every validation, so a blocked or malformed
        // request stream can never talk the pool into scaling up. Without
        // this, one of the two inference entry points was invisible to
        // PipelinePoolManager, so traffic arriving over the OpenAI-
        // compatible API could never scale the pipeline pool it needs.
        // (Pool-FIRST selection is deliberately not shared here: this
        // route has never consulted the pool -- that half predates Phase C
        // and is unchanged -- and wiring it in is a larger change than
        // closing the demand-blindness this phase introduced.)
        demandTracker.recordRequest(candidate.model);

        const node = selectNode(registry.listActive(reputation), reputation, candidate.model, random);
        if (!node) {
          sendJson(res, 503, {
            error: { message: `No active node currently serves model '${candidate.model}'.`, type: "invalid_request_error", code: null },
          });
          return;
        }

        const chatCompletionId = "chatcmpl-" + randomUUID();
        const createdAt = Math.floor(Date.now() / 1000);

        if (!stream) {
          try {
            const nodeRes = await fetch(`${node.endpoint}/complete`, {
              method: "POST",
              headers: { "content-type": "application/json", "authorization": `Bearer ${authToken}` },
              body: JSON.stringify({ prompt, n_predict: maxTokens }),
              signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
            });
            if (!nodeRes.ok) {
              sendJson(res, 502, { error: { message: `node returned status ${nodeRes.status}`, type: "invalid_request_error", code: null } });
              return;
            }
            const nodeBody = await nodeRes.json();
            if (typeof nodeBody.text !== "string") {
              sendJson(res, 502, { error: { message: "node returned a malformed response", type: "invalid_request_error", code: null } });
              return;
            }
            const promptTokens = typeof nodeBody.prompt_tokens === "number" ? nodeBody.prompt_tokens : 0;
            const completionTokens = typeof nodeBody.completion_tokens === "number" ? nodeBody.completion_tokens : 0;
            const finishReason = nodeBody.finish_reason === "length" ? "length" : "stop";
            sendJson(res, 200, {
              id: chatCompletionId,
              object: "chat.completion",
              created: createdAt,
              model: candidate.model,
              choices: [{ index: 0, message: { role: "assistant", content: nodeBody.text }, finish_reason: finishReason }],
              usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
            });
          } catch (err) {
            console.warn(`failed to forward /v1/chat/completions to node ${node.endpoint}:`, err);
            sendJson(res, 502, { error: { message: "failed to reach the selected node", type: "invalid_request_error", code: null } });
          }
          return;
        }

        try {
          const nodeRes = await fetch(`${node.endpoint}/complete`, {
            method: "POST",
            headers: { "content-type": "application/json", "authorization": `Bearer ${authToken}` },
            body: JSON.stringify({ prompt, n_predict: maxTokens, stream: true, includeUsage: true }),
            signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
          });
          const nodeContentType = (nodeRes.headers.get("content-type") ?? "").toLowerCase();
          if (!nodeRes.ok || !nodeRes.body || !nodeContentType.startsWith("text/event-stream")) {
            sendJson(res, 502, { error: { message: `node returned status ${nodeRes.status}`, type: "invalid_request_error", code: null } });
            return;
          }

          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          const baseChunk = { id: chatCompletionId, object: "chat.completion.chunk", created: createdAt, model: candidate.model };
          res.write(`data: ${JSON.stringify({ ...baseChunk, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);

          let finishReason: "stop" | "length" = "stop";
          let promptTokens = 0;
          let completionTokens = 0;
          const reader = nodeRes.body.getReader();
          // readSseFrames() throws if the node's stream ends without a
          // [DONE] sentinel or an error frame -- i.e. it can throw from
          // INSIDE this loop, after headers and real chunks have already
          // gone out. That case is deliberately not handled here: it falls
          // through to the catch below, which ends the connection without a
          // [DONE], so a caller sees the same truncation signal the node's
          // own wire protocol gives (see SwarmClient.generateStream()).
          // Synthesizing the trailing finish_reason chunk here anyway would
          // report a died-mid-generation reply as a completed one.
          for await (const frame of readSseFrames(reader)) {
            if (frame.event === "error") {
              const message = (() => {
                try {
                  return JSON.parse(frame.data).error ?? "generation failed mid-stream";
                } catch {
                  return "generation failed mid-stream";
                }
              })();
              res.write(`event: error\ndata: ${JSON.stringify({ error: { message, type: "invalid_request_error", code: null } })}\n\n`);
              res.end();
              return;
            }
            if (frame.event === "usage") {
              // Same untrusted-source treatment as the error frame above --
              // a malformed usage frame must not crash the relay loop.
              const usage = (() => {
                try {
                  return JSON.parse(frame.data);
                } catch {
                  return {};
                }
              })();
              promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
              completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
              finishReason = usage.finish_reason === "length" ? "length" : "stop";
              continue;
            }
            if (frame.event !== undefined) {
              // Any OTHER named event from a future node build is metadata,
              // not generated text -- the same reasoning that made
              // includeUsage opt-in in the first place (Task 2's design
              // doc: an unrecognized new event type must never silently
              // become visible content). Drop it rather than relay it.
              continue;
            }
            res.write(`data: ${JSON.stringify({ ...baseChunk, choices: [{ index: 0, delta: { content: frame.data }, finish_reason: null }] })}\n\n`);
          }

          res.write(`data: ${JSON.stringify({ ...baseChunk, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
          if (includeUsageInStream) {
            res.write(`data: ${JSON.stringify({ ...baseChunk, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } })}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
        } catch (err) {
          // Three distinct failures land here: an unreachable/timed-out node
          // (nothing sent yet -- a real 502 is still possible), a node whose
          // stream was truncated mid-generation (readSseFrames throws, but
          // headers are already committed), and any write failure after the
          // response began. Once headersSent is true the status line and
          // content-type are on the wire and cannot be revised, so ending
          // the connection is the only honest signal available -- identical
          // to POST /generate's own streaming branch.
          console.warn(`failed to forward streaming /v1/chat/completions to node ${node.endpoint}:`, err);
          if (!res.headersSent) {
            sendJson(res, 502, { error: { message: "failed to reach the selected node", type: "invalid_request_error", code: null } });
          } else {
            res.end();
          }
        }
        return;
      }

      if (method === "GET" && parts.length === 0) {
        serveStaticFile(res, "index.html", "text/html; charset=utf-8");
        return;
      }

      if (method === "GET" && parts.length === 1 && parts[0] === "app.js") {
        serveStaticFile(res, "app.js", "application/javascript; charset=utf-8");
        return;
      }

      if (method === "GET" && parts.length === 1 && parts[0] === "style.css") {
        serveStaticFile(res, "style.css", "text/css; charset=utf-8");
        return;
      }

      if (method === "GET" && parts.length === 1 && parts[0] === "openapi.json") {
        sendJson(res, 200, openApiDocument);
        return;
      }

      res.writeHead(404);
      res.end();
    } catch (err) {
      if (err instanceof JsonParseError) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      sendJson(res, 500, { error: "internal server error" });
    }
  });
}
