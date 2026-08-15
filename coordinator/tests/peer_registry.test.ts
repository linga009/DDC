import { test } from "node:test";
import assert from "node:assert/strict";
import { PeerRegistry } from "../src/peer_registry.ts";

test("register returns a peerId, and the peer is immediately active", () => {
  const registry = new PeerRegistry();
  const peerId = registry.register("http://192.168.1.50:8080");

  assert.equal(typeof peerId, "string");
  const active = registry.listActive();
  assert.equal(active.length, 1);
  assert.equal(active[0].peerId, peerId);
  assert.equal(active[0].endpoint, "http://192.168.1.50:8080");
});

test("heartbeat on a known peer returns true and keeps it active past the timeout", () => {
  let now = 0;
  const registry = new PeerRegistry(() => now);
  const peerId = registry.register("http://192.168.1.50:8080");

  now = 30001;
  registry.heartbeat(peerId);
  assert.equal(registry.listActive().length, 1);

  now = 60002;
  assert.equal(registry.listActive().length, 0);
});

test("heartbeat on an unknown peer returns false", () => {
  const registry = new PeerRegistry();
  assert.equal(registry.heartbeat("does-not-exist"), false);
});

test("a peer past the heartbeat timeout is excluded from listActive and cannot be revived", () => {
  let now = 0;
  const registry = new PeerRegistry(() => now);
  const peerId = registry.register("http://192.168.1.50:8080");

  now = 30001;
  assert.equal(registry.listActive().length, 0);
  assert.equal(registry.heartbeat(peerId), false);
});

test("deregister removes a peer immediately, and is idempotent-safe on unknown ids", () => {
  const registry = new PeerRegistry();
  const peerId = registry.register("http://192.168.1.50:8080");

  assert.equal(registry.deregister(peerId), true);
  assert.equal(registry.listActive().length, 0);
  assert.equal(registry.deregister(peerId), false);
  assert.equal(registry.deregister("never-existed"), false);
});

test("multiple peers are tracked independently", () => {
  const registry = new PeerRegistry();
  const a = registry.register("http://host-a:8080");
  const b = registry.register("http://host-b:8080");

  assert.notEqual(a, b);
  assert.equal(registry.listActive().length, 2);
});
