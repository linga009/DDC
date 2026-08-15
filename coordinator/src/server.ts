import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { NodeRegistry, type DeviceTier } from "./registry.ts";
import { ModelCatalog } from "./catalog.ts";
import { PeerRegistry } from "./peer_registry.ts";

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

async function fetchPeerCapacity(endpoint: string): Promise<number> {
  try {
    const res = await fetch(`${endpoint}/capacity`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) {
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

async function federatedActiveNodeCount(registry: NodeRegistry, peers: PeerRegistry): Promise<number> {
  const local = registry.listActive().length;
  const peerCounts = await Promise.all(
    peers.listActive().map(peer => fetchPeerCapacity(peer.endpoint)));
  return local + peerCounts.reduce((sum, n) => sum + n, 0);
}

export function createServer(registry: NodeRegistry, catalog: ModelCatalog, peers: PeerRegistry) {
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
        const nodeId = registry.register(candidate.endpoint, candidate.deviceTier as DeviceTier);
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

      if (method === "GET" && parts[0] === "nodes" && parts.length === 1) {
        sendJson(res, 200, registry.listActive());
        return;
      }

      if (method === "GET" && parts[0] === "capacity" && parts.length === 1) {
        sendJson(res, 200, { activeNodes: registry.listActive().length });
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
        const peerId = peers.register(candidate.endpoint);
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
        const activeNodeCount = await federatedActiveNodeCount(registry, peers);
        sendJson(res, 200, catalog.availability(activeNodeCount));
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
