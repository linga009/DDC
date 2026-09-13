import { test } from "node:test";
import assert from "node:assert/strict";
import { PeerRegistry } from "../src/peer_registry.ts";
import { canonicalizeEndpoint } from "../src/endpoint_identity.ts";

// "http://192.168.1.50:8080" is an IP literal, so canonicalizeEndpoint
// never touches DNS for it -- safe to call with the real default resolver
// throughout this file. The one exception (host-a/host-b, a real
// hostname) uses an injected fake resolver instead, matching
// endpoint_identity.test.ts's own established convention for never
// letting a test depend on real DNS.
const IDENTITY_KEY = await canonicalizeEndpoint("http://192.168.1.50:8080");

test("register returns a peerId, and the peer is immediately active", async () => {
  const registry = new PeerRegistry();
  const peerId = registry.register("http://192.168.1.50:8080", IDENTITY_KEY);

  assert.equal(typeof peerId, "string");
  const active = registry.listActive();
  assert.equal(active.length, 1);
  assert.equal(active[0].peerId, peerId);
  assert.equal(active[0].endpoint, "http://192.168.1.50:8080");
});

test("heartbeat before expiry refreshes lastSeen and keeps the peer active past the original window", async () => {
  let now = 0;
  const registry = new PeerRegistry(() => now);
  const peerId = registry.register("http://192.168.1.50:8080", IDENTITY_KEY);

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

test("heartbeat on an unknown peer returns false", async () => {
  const registry = new PeerRegistry();
  assert.equal(registry.heartbeat("does-not-exist"), false);
});

test("a peer past the heartbeat timeout is excluded from listActive and cannot be revived", async () => {
  let now = 0;
  const registry = new PeerRegistry(() => now);
  const peerId = registry.register("http://192.168.1.50:8080", IDENTITY_KEY);

  now = 30001;
  assert.equal(registry.listActive().length, 0);
  assert.equal(registry.heartbeat(peerId), false);
});

test("deregister removes a peer immediately, and is idempotent-safe on unknown ids", async () => {
  const registry = new PeerRegistry();
  const peerId = registry.register("http://192.168.1.50:8080", IDENTITY_KEY);

  assert.equal(registry.deregister(peerId), true);
  assert.equal(registry.listActive().length, 0);
  assert.equal(registry.deregister(peerId), false);
  assert.equal(registry.deregister("never-existed"), false);
});

test("multiple peers are tracked independently", async () => {
  // A fake resolver, not the real default one: "host-a"/"host-b" are not
  // real DNS names, and canonicalizeEndpoint's own established convention
  // (endpoint_identity.test.ts) is never letting a test depend on real
  // DNS resolution succeeding, failing, or timing out in a particular way.
  const fakeResolver = async (hostname: string) => `10.0.0.${hostname === "host-a" ? 1 : 2}`;
  const registry = new PeerRegistry();
  const a = registry.register("http://host-a:8080", await canonicalizeEndpoint("http://host-a:8080", fakeResolver));
  const b = registry.register("http://host-b:8080", await canonicalizeEndpoint("http://host-b:8080", fakeResolver));

  assert.notEqual(a, b);
  assert.equal(registry.listActive().length, 2);
});

test("registering the same endpoint twice returns the same peerId and does not double-count in listActive", async () => {
  const registry = new PeerRegistry();
  const first = registry.register("http://192.168.1.50:8080", IDENTITY_KEY);
  const second = registry.register("http://192.168.1.50:8080", IDENTITY_KEY);

  assert.equal(first, second);
  assert.equal(registry.listActive().length, 1);
});

test("registering the same endpoint after the previous registration expired mints a fresh peerId, not a revival of the stale one", async () => {
  let now = 0;
  const registry = new PeerRegistry(() => now);
  const first = registry.register("http://192.168.1.50:8080", IDENTITY_KEY);

  // Past the 30s timeout with no heartbeat -- the original entry is stale.
  now = 30001;
  const second = registry.register("http://192.168.1.50:8080", IDENTITY_KEY);

  // Must be a fresh registration (new peerId), never a silent revival of
  // the expired entry under its old peerId -- that would reintroduce the
  // same "depends on incidental pruning order" nondeterminism that
  // heartbeat() is explicitly designed to avoid.
  assert.notEqual(second, first);
  const active = registry.listActive();
  assert.equal(active.length, 1);
  assert.equal(active[0].peerId, second);
});

test("registering the same endpoint again refreshes lastSeen, keeping the peer active past the original window", async () => {
  let now = 0;
  const registry = new PeerRegistry(() => now);
  const peerId = registry.register("http://192.168.1.50:8080", IDENTITY_KEY);

  now = 20000;
  const again = registry.register("http://192.168.1.50:8080", IDENTITY_KEY);
  assert.equal(again, peerId);

  // 45s after the original registration -- past the ORIGINAL 30s window,
  // but only 25s after the re-register refreshed lastSeen, so still within
  // a fresh 30s window. If the duplicate register hadn't refreshed
  // lastSeen, this peer would already be expired (45000 - 0 > 30000).
  now = 45000;
  assert.equal(registry.listActive().length, 1);
});

test("registering a peer under a loopback alias dedupes to the same peerId, not a second peer", async () => {
  // Same class as the node/launcher headline tests: one physical
  // coordinator reachable as both 127.0.0.1 and localhost must not
  // double-count its reported capacity in the federated aggregate just
  // because it was reached under a different alias the second time.
  const registry = new PeerRegistry();
  const first = registry.register("http://127.0.0.1:9090", await canonicalizeEndpoint("http://127.0.0.1:9090"));
  const second = registry.register("http://localhost:9090", await canonicalizeEndpoint("http://localhost:9090"));

  assert.equal(second, first, "an alias must resolve to the SAME peerId, not a fresh one");
  assert.equal(registry.listActive().length, 1, "the alias must overwrite the existing entry, not add a second one");
});
