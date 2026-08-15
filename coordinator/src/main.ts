import { createServer } from "./server.ts";
import { NodeRegistry } from "./registry.ts";
import { ModelCatalog } from "./catalog.ts";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST || "127.0.0.1";
const registry = new NodeRegistry();
const catalog = new ModelCatalog();
const server = createServer(registry, catalog);

server.listen(port, host, () => {
  console.log(`coordinator listening on ${host}:${port} (no authentication -- trusted networks only)`);
});
