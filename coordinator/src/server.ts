import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { NodeRegistry, type DeviceTier } from "./registry.ts";
import { ModelCatalog } from "./catalog.ts";

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw.length > 0 ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

export function createServer(registry: NodeRegistry, catalog: ModelCatalog) {
  return createHttpServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    if (method === "POST" && parts[0] === "nodes" && parts.length === 2 && parts[1] === "register") {
      const body = (await readJsonBody(req)) as { endpoint?: string; deviceTier?: DeviceTier };
      if (!body.endpoint || !body.deviceTier) {
        sendJson(res, 400, { error: "endpoint and deviceTier are required" });
        return;
      }
      const nodeId = registry.register(body.endpoint, body.deviceTier);
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

    if (method === "GET" && parts[0] === "catalog" && parts.length === 1) {
      sendJson(res, 200, catalog.availability(registry.listActive().length));
      return;
    }

    res.writeHead(404);
    res.end();
  });
}
