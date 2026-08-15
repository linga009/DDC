import { createServer } from "./server.ts";
import { NodeRegistry } from "./registry.ts";
import { ModelCatalog } from "./catalog.ts";

const port = Number(process.env.PORT ?? 8080);
const registry = new NodeRegistry();
const catalog = new ModelCatalog();
const server = createServer(registry, catalog);

server.listen(port, () => {
  console.log(`coordinator listening on port ${port}`);
});
