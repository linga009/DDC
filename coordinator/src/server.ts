import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { NodeRegistry, type DeviceTier, type NodeInfo } from "./registry.ts";
import { ModelCatalog } from "./catalog.ts";
import { PeerRegistry } from "./peer_registry.ts";
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("classifier timed out")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
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

export function createServer(registry: NodeRegistry, catalog: ModelCatalog, peers: PeerRegistry, classifier: SafetyClassifier, reputation: ReputationTracker, authToken: string, random: () => number = Math.random) {
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
        const nodeId = registry.register(normalizedNodeEndpoint, candidate.deviceTier as DeviceTier, localityGroup, servesModel);
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
        const peerId = peers.register(normalizedEndpoint);
        sendJson(res, 200, { peerId });
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

        const node = selectNode(registry.listActive(reputation), reputation, candidate.modelId, random);
        if (!node) {
          sendJson(res, 503, { error: `no active node currently serves model "${candidate.modelId}"` });
          return;
        }

        if (stream) {
          try {
            const nodeRes = await fetch(`${node.endpoint}/complete`, {
              method: "POST",
              headers: { "content-type": "application/json", "authorization": `Bearer ${authToken}` },
              body: JSON.stringify({ prompt: candidate.prompt, n_predict: nPredict, stream: true }),
              signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
            });
            if (!nodeRes.ok || !nodeRes.body) {
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
            sendJson(res, 502, { error: `node returned status ${nodeRes.status}` });
            return;
          }
          const nodeBody = await nodeRes.json();
          if (typeof nodeBody.text !== "string") {
            sendJson(res, 502, { error: "node returned a malformed response" });
            return;
          }
          sendJson(res, 200, { text: nodeBody.text });
        } catch (err) {
          console.warn(`failed to forward /generate to node ${node.endpoint}:`, err);
          sendJson(res, 502, { error: "failed to reach the selected node" });
        }
        return;
      }

      if (method === "GET" && parts[0] === "v1" && parts[1] === "models" && parts.length === 2) {
        // catalog.availability()'s per-entry `available` field is dropped
        // below (OpenAI's schema has no place for it -- this route lists
        // every catalog entry regardless, see the comment on data), so the
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
