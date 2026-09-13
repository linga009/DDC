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

// Whole-branch review, Minor finding, fixed here: dns.lookup() has no
// timeout of its own, and this function's only caller-visible bound used
// to be the /identity fetch's own AbortSignal.timeout() in server.ts --
// which wraps nothing but that fetch, not resolution. A resolver that
// simply never resolves (a hung DNS server, not one that fails fast) used
// to stall registration indefinitely; it now falls back the same way an
// outright failure already did, within a bounded time. This genuinely
// waits out the real timeout (like the identity-timeout test in
// server.test.ts) rather than mocking timers, so it proves the bound is
// actually enforced, not just documented.
test("canonicalizeEndpoint: a resolver that never resolves falls back to the literal hostname once the DNS timeout elapses", async () => {
  const neverResolves: (hostname: string) => Promise<string> = () => new Promise(() => { /* never settles */ });
  const start = Date.now();
  const key = await canonicalizeEndpoint("http://hung-resolver.example:9000", neverResolves);
  const elapsedMs = Date.now() - start;
  assert.equal(key, "hung-resolver.example:9000");
  assert.ok(elapsedMs < 10000, `fell back after ${elapsedMs}ms -- the DNS lookup timeout does not appear to be enforced`);
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

test("canonicalizeEndpoint: an IPv4 loopback address other than 127.0.0.1 does NOT canonicalize to loopback -- it is its own identity", async () => {
  // Deliberately narrower than "any address in 127.0.0.0/8": whole-branch
  // review live-verified that broader rule collapsing 127.0.0.1 and
  // 127.0.0.2 -- two genuinely different bind addresses that can host two
  // unrelated real processes -- into one identity for free, no DNS
  // trickery needed. See isLoopbackAddress()'s own comment.
  const key = await canonicalizeEndpoint("http://127.5.5.5:8080");
  assert.equal(key, "127.5.5.5:8080");
});

test("canonicalizeEndpoint: 0.0.0.0 and an IPv4-mapped-IPv6 spelling of 127.0.0.1 also canonicalize to loopback", async () => {
  assert.equal(await canonicalizeEndpoint("http://0.0.0.0:8080"), "loopback:8080");
  assert.equal(await canonicalizeEndpoint("http://[::ffff:127.0.0.1]:8080"), "loopback:8080");
});

test("isLoopbackAddress: recognizes 127.0.0.1, ::1, 0.0.0.0, an IPv4-mapped spelling of 127.0.0.1, and the literal hostname localhost", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("0.0.0.0"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("localhost"), true);
});

test("isLoopbackAddress: does not flag a DIFFERENT IPv4 address merely because it is in the 127.0.0.0/8 range", () => {
  assert.equal(isLoopbackAddress("127.5.5.5"), false);
  assert.equal(isLoopbackAddress("127.0.0.2"), false);
});

test("isLoopbackAddress: does not flag an ordinary public IP or hostname", () => {
  assert.equal(isLoopbackAddress("93.184.216.34"), false);
  assert.equal(isLoopbackAddress("example.com"), false);
  assert.equal(isLoopbackAddress("10.0.0.5"), false);
});
