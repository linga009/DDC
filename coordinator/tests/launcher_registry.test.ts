import { test } from "node:test";
import assert from "node:assert/strict";
import { LauncherRegistry } from "../src/launcher_registry.ts";

test("register returns a launcherId and listActive reports it", () => {
  const registry = new LauncherRegistry();
  const launcherId = registry.register("http://127.0.0.1:9000", ["mixtral-8x7b"], 8090);
  assert.equal(typeof launcherId, "string");
  const [launcher] = registry.listActive();
  assert.deepEqual(launcher, { launcherId, endpoint: "http://127.0.0.1:9000", servesModels: ["mixtral-8x7b"], agentPort: 8090 });
});

test("re-registering the same endpoint refreshes it instead of duplicating", () => {
  const registry = new LauncherRegistry();
  const first = registry.register("http://127.0.0.1:9000", ["mixtral-8x7b"], 8090);
  const second = registry.register("http://127.0.0.1:9000", ["mixtral-8x7b", "mixtral-8x22b"], 8090);
  assert.equal(first, second);
  assert.equal(registry.listActive().length, 1);
  assert.deepEqual(registry.listActive()[0].servesModels, ["mixtral-8x7b", "mixtral-8x22b"]);
});

test("heartbeat renews an active launcher and returns true", () => {
  const clock = { now: 1000 };
  const registry = new LauncherRegistry(() => clock.now, 30000);
  const launcherId = registry.register("http://127.0.0.1:9000", ["mixtral-8x7b"], 8090);
  clock.now += 20000;
  assert.equal(registry.heartbeat(launcherId), true);
  clock.now += 20000;  // 40000 total from registration -- would be expired without the heartbeat renewal
  assert.equal(registry.listActive().length, 1);
});

test("heartbeat on an unknown launcherId returns false", () => {
  const registry = new LauncherRegistry();
  assert.equal(registry.heartbeat("nonexistent"), false);
});

test("listActive prunes an expired launcher", () => {
  const clock = { now: 1000 };
  const registry = new LauncherRegistry(() => clock.now, 30000);
  registry.register("http://127.0.0.1:9000", ["mixtral-8x7b"], 8090);
  clock.now += 40000;
  assert.equal(registry.listActive().length, 0);
});

test("findForModel returns an active launcher that declares the model", () => {
  const registry = new LauncherRegistry();
  registry.register("http://127.0.0.1:9000", ["mixtral-8x7b"], 8090);
  registry.register("http://127.0.0.1:9001", ["mixtral-8x22b"], 8091);
  const found = registry.findForModel("mixtral-8x22b");
  assert.equal(found?.endpoint, "http://127.0.0.1:9001");
});

test("findForModel returns undefined when no active launcher declares the model", () => {
  const registry = new LauncherRegistry();
  registry.register("http://127.0.0.1:9000", ["mixtral-8x7b"], 8090);
  assert.equal(registry.findForModel("mixtral-8x22b"), undefined);
});

test("findForModel does not return an expired launcher", () => {
  const clock = { now: 1000 };
  const registry = new LauncherRegistry(() => clock.now, 30000);
  registry.register("http://127.0.0.1:9000", ["mixtral-8x7b"], 8090);
  clock.now += 40000;
  assert.equal(registry.findForModel("mixtral-8x7b"), undefined);
});
