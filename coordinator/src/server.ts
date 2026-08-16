import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { NodeRegistry, type DeviceTier } from "./registry.ts";
import { ModelCatalog } from "./catalog.ts";
import { PeerRegistry } from "./peer_registry.ts";
import type { SafetyClassifier } from "./safety_classifier.ts";
import type { ReputationTracker } from "./reputation_tracker.ts";

const VALID_DEVICE_TIERS: readonly DeviceTier[] = ["desktop", "android", "ios"];

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

const CLASSIFY_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("classifier timed out")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function fetchPeerCapacity(endpoint: string): Promise<number> {
  try {
    const res = await fetch(`${endpoint}/capacity`, { signal: AbortSignal.timeout(2000) });
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

async function federatedActiveNodeCount(registry: NodeRegistry, peers: PeerRegistry, reputation: ReputationTracker): Promise<number> {
  const local = registry.listActive(reputation).length;
  const peerCounts = await Promise.all(
    peers.listActive().map(peer => fetchPeerCapacity(peer.endpoint)));
  return local + peerCounts.reduce((sum, n) => sum + n, 0);
}

export function createServer(registry: NodeRegistry, catalog: ModelCatalog, peers: PeerRegistry, classifier: SafetyClassifier, reputation: ReputationTracker) {
  return createHttpServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);

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
        const nodeId = registry.register(candidate.endpoint, candidate.deviceTier as DeviceTier, localityGroup);
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
        const asObject: Record<string, unknown> = {};
        for (const [key, nodes] of groups) {
          asObject[key] = nodes;
        }
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
        const activeNodeCount = await federatedActiveNodeCount(registry, peers, reputation);
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
          sendJson(res, 200, { safe, categories: categories.map(String) });
        } catch {
          // Fail closed: a classifier error (including a malformed result or
          // a timeout) must never be treated as "safe".
          sendJson(res, 200, { safe: false, categories: ["classifier_error"] });
        }
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
