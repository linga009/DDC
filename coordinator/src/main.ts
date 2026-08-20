import { createServer } from "./server.ts";
import { NodeRegistry } from "./registry.ts";
import { ModelCatalog } from "./catalog.ts";
import { PeerRegistry } from "./peer_registry.ts";
import { KeywordSafetyClassifier } from "./safety_classifier.ts";
import { ReputationTracker } from "./reputation_tracker.ts";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST || "127.0.0.1";
const authToken = process.env.SWARM_AUTH_TOKEN;
if (!authToken) {
  console.error("SWARM_AUTH_TOKEN environment variable must be set -- refusing to start unauthenticated");
  process.exit(1);
}
const registry = new NodeRegistry();
const catalog = new ModelCatalog();
const peers = new PeerRegistry();
const classifier = new KeywordSafetyClassifier([]);
const reputation = new ReputationTracker();
const server = createServer(registry, catalog, peers, classifier, reputation, authToken);

server.listen(port, host, () => {
  console.log(`coordinator listening on ${host}:${port} (authentication required -- see SWARM_AUTH_TOKEN)`);
});
