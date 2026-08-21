import { createServer } from "./server.ts";
import { NodeRegistry } from "./registry.ts";
import { ModelCatalog } from "./catalog.ts";
import { PeerRegistry } from "./peer_registry.ts";
import { KeywordSafetyClassifier, type KeywordRule } from "./safety_classifier.ts";
import { ReputationTracker } from "./reputation_tracker.ts";
import { loadSafetyRules, SafetyRulesError } from "./safety_rules_loader.ts";

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
// Fail fast on a bad ruleset the same way the SWARM_AUTH_TOKEN checks above
// do -- one actionable console.error line and exit(1), not a raw stack trace
// from an uncaught exception. README describes this as "the same posture as
// SWARM_AUTH_TOKEN"; this is what makes that literally true.
let rules: KeywordRule[];
try {
  rules = loadSafetyRules(new URL("../safety_rules.json", import.meta.url));
} catch (err) {
  if (err instanceof SafetyRulesError) {
    console.error(`${err.message} -- refusing to start without a working safety classifier`);
    process.exit(1);
  }
  throw err;
}
const classifier = new KeywordSafetyClassifier(rules);
const ruleCategoryCount = new Set(rules.map(r => r.category)).size;
const reputation = new ReputationTracker();
const server = createServer(registry, catalog, peers, classifier, reputation, authToken);

server.listen(port, host, () => {
  // The rule/category counts are a POSITIVE signal that the safety gate is
  // armed. Without them, an operator's only evidence is the absence of a
  // crash -- which is indistinguishable from a ruleset that loaded but does
  // nothing.
  console.log(
    `coordinator listening on ${host}:${port} (authentication required -- see SWARM_AUTH_TOKEN; ` +
    `safety classifier armed with ${rules.length} rules across ${ruleCategoryCount} categories)`,
  );
});
