import { test } from "node:test";
import assert from "node:assert/strict";
import { LauncherRegistry } from "../src/launcher_registry.ts";
import { canonicalizeEndpoint } from "../src/endpoint_identity.ts";

test("register returns a launcherId and listActive reports it", async () => {
  const registry = new LauncherRegistry();
  const identityKey = await canonicalizeEndpoint("http://127.0.0.1:9000");
  const launcherId = registry.register("http://127.0.0.1:9000", identityKey, ["mixtral-8x7b"], 8090);
  assert.equal(typeof launcherId, "string");
  const [launcher] = registry.listActive();
  assert.deepEqual(launcher, { launcherId, endpoint: "http://127.0.0.1:9000", identityKey, servesModels: ["mixtral-8x7b"], agentPort: 8090 });
});

test("re-registering the same endpoint refreshes it instead of duplicating", async () => {
  const registry = new LauncherRegistry();
  const first = registry.register("http://127.0.0.1:9000", await canonicalizeEndpoint("http://127.0.0.1:9000"), ["mixtral-8x7b"], 8090);
  const second = registry.register("http://127.0.0.1:9000", await canonicalizeEndpoint("http://127.0.0.1:9000"), ["mixtral-8x7b", "mixtral-8x22b"], 8090);
  assert.equal(first, second);
  assert.equal(registry.listActive().length, 1);
  assert.deepEqual(registry.listActive()[0].servesModels, ["mixtral-8x7b", "mixtral-8x22b"]);
});

// This is the headline test for Endpoint Identity Hardening's launcher
// half. Before identityKey existed, register() matched purely on raw
// endpoint equality, so one physical launcher reachable as both
// http://127.0.0.1:P and http://localhost:P registered as TWO separate
// entries -- and since a swarm-launcher supervises exactly one agent at a
// time, a second model could then claim the "other" one and receive the
// first model's weights. Live-verified during Phase C's third
// whole-branch review as a real wrong-model-served bug.
test("registering under a loopback alias is recognised as the same launcher, not a second one", async () => {
  const registry = new LauncherRegistry();
  const first = registry.register("http://127.0.0.1:9000", await canonicalizeEndpoint("http://127.0.0.1:9000"), ["mixtral-8x7b"], 8090);
  const second = registry.register("http://localhost:9000", await canonicalizeEndpoint("http://localhost:9000"), ["mixtral-8x7b"], 8090);

  assert.equal(second, first, "an alias must resolve to the SAME launcherId, not a fresh one");
  assert.equal(registry.listActive().length, 1, "the alias must overwrite the existing entry, not add a second one");
});

test("heartbeat renews an active launcher and returns true", async () => {
  const clock = { now: 1000 };
  const registry = new LauncherRegistry(() => clock.now, 30000);
  const launcherId = registry.register("http://127.0.0.1:9000", await canonicalizeEndpoint("http://127.0.0.1:9000"), ["mixtral-8x7b"], 8090);
  clock.now += 20000;
  assert.equal(registry.heartbeat(launcherId), true);
  clock.now += 20000;  // 40000 total from registration -- would be expired without the heartbeat renewal
  assert.equal(registry.listActive().length, 1);
});

test("heartbeat on an unknown launcherId returns false", async () => {
  const registry = new LauncherRegistry();
  assert.equal(registry.heartbeat("nonexistent"), false);
});

test("listActive prunes an expired launcher", async () => {
  const clock = { now: 1000 };
  const registry = new LauncherRegistry(() => clock.now, 30000);
  registry.register("http://127.0.0.1:9000", await canonicalizeEndpoint("http://127.0.0.1:9000"), ["mixtral-8x7b"], 8090);
  clock.now += 40000;
  assert.equal(registry.listActive().length, 0);
});

test("findForModel returns an active launcher that declares the model", async () => {
  const registry = new LauncherRegistry();
  registry.register("http://127.0.0.1:9000", await canonicalizeEndpoint("http://127.0.0.1:9000"), ["mixtral-8x7b"], 8090);
  registry.register("http://127.0.0.1:9001", await canonicalizeEndpoint("http://127.0.0.1:9001"), ["mixtral-8x22b"], 8091);
  const found = registry.findForModel("mixtral-8x22b");
  assert.equal(found?.endpoint, "http://127.0.0.1:9001");
});

test("findForModel returns undefined when no active launcher declares the model", async () => {
  const registry = new LauncherRegistry();
  registry.register("http://127.0.0.1:9000", await canonicalizeEndpoint("http://127.0.0.1:9000"), ["mixtral-8x7b"], 8090);
  assert.equal(registry.findForModel("mixtral-8x22b"), undefined);
});

test("findForModel does not return an expired launcher", async () => {
  const clock = { now: 1000 };
  const registry = new LauncherRegistry(() => clock.now, 30000);
  registry.register("http://127.0.0.1:9000", await canonicalizeEndpoint("http://127.0.0.1:9000"), ["mixtral-8x7b"], 8090);
  clock.now += 40000;
  assert.equal(registry.findForModel("mixtral-8x7b"), undefined);
});

test("listForModel returns every active launcher declaring the model", async () => {
  const registry = new LauncherRegistry();
  registry.register("http://127.0.0.1:9000", await canonicalizeEndpoint("http://127.0.0.1:9000"), ["mixtral-8x7b"], 8090);
  registry.register("http://127.0.0.1:9001", await canonicalizeEndpoint("http://127.0.0.1:9001"), ["mixtral-8x7b"], 8091);
  registry.register("http://127.0.0.1:9002", await canonicalizeEndpoint("http://127.0.0.1:9002"), ["mixtral-8x22b"], 8092);
  const found = registry.listForModel("mixtral-8x7b");
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(l => l.endpoint).sort(), ["http://127.0.0.1:9000", "http://127.0.0.1:9001"]);
});

test("listForModel returns an empty array when no active launcher declares the model", async () => {
  const registry = new LauncherRegistry();
  registry.register("http://127.0.0.1:9000", await canonicalizeEndpoint("http://127.0.0.1:9000"), ["mixtral-8x7b"], 8090);
  assert.deepEqual(registry.listForModel("mixtral-8x22b"), []);
});

test("listForModel excludes an expired launcher", async () => {
  const clock = { now: 1000 };
  const registry = new LauncherRegistry(() => clock.now, 30000);
  registry.register("http://127.0.0.1:9000", await canonicalizeEndpoint("http://127.0.0.1:9000"), ["mixtral-8x7b"], 8090);
  clock.now += 40000;
  assert.deepEqual(registry.listForModel("mixtral-8x7b"), []);
});
