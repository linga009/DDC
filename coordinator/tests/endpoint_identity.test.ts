import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeEndpoint, isLoopbackAddress } from "../src/endpoint_identity.ts";

// Spy resolver: records calls, and lets each test script its DNS answers
// (or a throw) without touching real DNS -- same injectable-dependency
// idiom as NodeRegistry's `clock` (coordinator/src/registry.ts).
function fakeResolver(answers: Record<string, string>): (hostname: string) => Promise<string> {
  return async (hostname: string) => {
    if (hostname in answers) {
      return answers[hostname];
    }
    throw new Error(`fakeResolver: no answer configured for ${hostname}`);
  };
}

function throwingResolver(): (hostname: string) => Promise<string> {
  return async () => {
    throw new Error("resolver exploded");
  };
}

function spyResolverThatThrowsIfCalled(): (hostname: string) => Promise<string> {
  return async (hostname: string) => {
    throw new Error(`resolver should not have been called for ${hostname}`);
  };
}

test("canonicalizeEndpoint: 127.0.0.1, localhost, [::1], and a trailing-dot FQDN all produce the same key", async () => {
  const loopbackKey = await canonicalizeEndpoint("http://127.0.0.1:8080");
  const localhostKey = await canonicalizeEndpoint("http://localhost:8080");
  const ipv6Key = await canonicalizeEndpoint("http://[::1]:8080");
  const trailingDotKey = await canonicalizeEndpoint("http://LocalHost.:8080");

  assert.equal(loopbackKey, "loopback:8080");
  assert.equal(localhostKey, "loopback:8080");
  assert.equal(ipv6Key, "loopback:8080");
  assert.equal(trailingDotKey, "loopback:8080");
});

test("canonicalizeEndpoint: same loopback host, different ports, produce different keys", async () => {
  const a = await canonicalizeEndpoint("http://127.0.0.1:8080");
  const b = await canonicalizeEndpoint("http://127.0.0.1:8081");
  assert.notEqual(a, b);
});

test("canonicalizeEndpoint: http and https on the same host with no explicit port produce different keys (80 vs 443)", async () => {
  const httpKey = await canonicalizeEndpoint("http://example.com", fakeResolver({ "example.com": "93.184.216.34" }));
  const httpsKey = await canonicalizeEndpoint("https://example.com", fakeResolver({ "example.com": "93.184.216.34" }));
  assert.equal(httpKey, "93.184.216.34:80");
  assert.equal(httpsKey, "93.184.216.34:443");
  assert.notEqual(httpKey, httpsKey);
});

test("canonicalizeEndpoint: http://example.com:443 and https://example.com produce the same key -- scheme is genuinely excluded", async () => {
  const resolver = fakeResolver({ "example.com": "93.184.216.34" });
  const explicitPortKey = await canonicalizeEndpoint("http://example.com:443", resolver);
  const schemeDefaultKey = await canonicalizeEndpoint("https://example.com", resolver);
  assert.equal(explicitPortKey, schemeDefaultKey);
  assert.equal(explicitPortKey, "93.184.216.34:443");
});

test("canonicalizeEndpoint: two distinct hostnames resolving to the same IP produce the same key", async () => {
  const resolver = fakeResolver({
    "node-a.example.com": "10.0.0.5",
    "node-b.example.com": "10.0.0.5",
  });
  const keyA = await canonicalizeEndpoint("http://node-a.example.com:9000", resolver);
  const keyB = await canonicalizeEndpoint("http://node-b.example.com:9000", resolver);
  assert.equal(keyA, keyB);
  assert.equal(keyA, "10.0.0.5:9000");
});

test("canonicalizeEndpoint: a resolver that throws falls back to the literal hostname instead of rejecting", async () => {
  const key = await canonicalizeEndpoint("http://unresolvable.example:9000", throwingResolver());
  assert.equal(key, "unresolvable.example:9000");
});

test("canonicalizeEndpoint: an IP literal never calls the resolver", async () => {
  const key = await canonicalizeEndpoint("http://192.168.1.5:9000", spyResolverThatThrowsIfCalled());
  assert.equal(key, "192.168.1.5:9000");
});

test("canonicalizeEndpoint: an IPv6 literal never calls the resolver", async () => {
  const key = await canonicalizeEndpoint("http://[2001:db8::1]:9000", spyResolverThatThrowsIfCalled());
  assert.equal(key, "2001:db8::1:9000");
});

test("canonicalizeEndpoint: throws a TypeError for an unparseable endpoint", async () => {
  await assert.rejects(() => canonicalizeEndpoint("not a url"), TypeError);
});

test("canonicalizeEndpoint: a loopback IP outside 127.0.0.1 (127.0.0.1/8 range) still canonicalizes to loopback", async () => {
  const key = await canonicalizeEndpoint("http://127.5.5.5:8080");
  assert.equal(key, "loopback:8080");
});

test("isLoopbackAddress: recognizes ::1, 127.0.0.0/8 addresses, and the literal hostname localhost", () => {
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.5.5.5"), true);
  assert.equal(isLoopbackAddress("localhost"), true);
});

test("isLoopbackAddress: does not flag an ordinary public IP or hostname", () => {
  assert.equal(isLoopbackAddress("93.184.216.34"), false);
  assert.equal(isLoopbackAddress("example.com"), false);
  assert.equal(isLoopbackAddress("10.0.0.5"), false);
});
