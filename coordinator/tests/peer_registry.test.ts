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

test("heartbeat before expiry refreshes lastSeen and keeps the peer active past the original window", () => {
  let now = 0;
  const registry = new PeerRegistry(() => now);
  const peerId = registry.register("http://192.168.1.50:8080");

  // Heartbeat while still well within the 30s window (not yet expired).
  now = 20000;
  assert.equal(registry.heartbeat(peerId), true);

  // 45s after registration -- past the ORIGINAL window, but only 25s after
  // the heartbeat refreshed lastSeen, so still within a fresh 30s window.
  // If the heartbeat hadn't refreshed lastSeen, this peer would already be
  // expired (45000 - 0 > 30000).
  now = 45000;
  assert.equal(registry.listActive().length, 1);
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

test("registering the same endpoint twice returns the same peerId and does not double-count in listActive", () => {
  const registry = new PeerRegistry();
  const first = registry.register("http://192.168.1.50:8080");
  const second = registry.register("http://192.168.1.50:8080");

  assert.equal(first, second);
  assert.equal(registry.listActive().length, 1);
});

test("registering the same endpoint again refreshes lastSeen, keeping the peer active past the original window", () => {
  let now = 0;
  const registry = new PeerRegistry(() => now);
  const peerId = registry.register("http://192.168.1.50:8080");

  now = 20000;
  const again = registry.register("http://192.168.1.50:8080");
  assert.equal(again, peerId);

  // 45s after the original registration -- past the ORIGINAL 30s window,
  // but only 25s after the re-register refreshed lastSeen, so still within
  // a fresh 30s window. If the duplicate register hadn't refreshed
  // lastSeen, this peer would already be expired (45000 - 0 > 30000).
  now = 45000;
  assert.equal(registry.listActive().length, 1);
});
