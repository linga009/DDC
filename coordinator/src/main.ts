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
// A token carrying a CR/LF or surrounding spaces/tabs can never authenticate
// anyone: Node's HTTP parser strips optional whitespace from a received
// header value (as does core/src/http_server.cpp), so the value that arrives
// on the wire is never byte-equal to a configured token that still has that
// whitespace baked in. Left unchecked, the coordinator starts, logs a
// perfectly healthy "listening ... authentication required" line, and then
// 401s every request forever -- including one sending the byte-exact token.
// This is the likeliest real misconfiguration there is
// (SWARM_AUTH_TOKEN=$(cat secret.txt), a .env line with a trailing space,
// docker --env-file), so fail fast instead. Deliberately NOT trimmed: an
// operator should be told their secret isn't what they think it is, not have
// it silently rewritten out from under them.
if (/[\r\n]/.test(authToken) || authToken !== authToken.trim()) {
  console.error(
    "SWARM_AUTH_TOKEN must not contain leading/trailing whitespace or newlines -- " +
    "check for a trailing newline from a file read (SWARM_AUTH_TOKEN=$(cat secret.txt)) " +
    "or from .env parsing. Refusing to start with a token no client could ever match.",
  );
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
