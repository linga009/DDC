import { promises as dns } from "node:dns";

// Injectable, same idiom as NodeRegistry's `clock` (coordinator/src/registry.ts)
// -- tests script a fake resolver instead of touching real DNS.
export type HostResolver = (hostname: string) => Promise<string>;

// Whole-branch review, Minor finding, fixed here: dns.lookup() has no
// timeout of its own, and canonicalizeEndpoint()'s only caller-visible
// bound is the /identity fetch's own AbortSignal.timeout() -- which wraps
// nothing but that fetch, not this resolution step. A slow or hung
// resolver could stall POST /nodes/register, /launchers/register, and
// /peers/register indefinitely, all of which canonicalize before doing
// anything else. Applied to whichever resolver canonicalizeEndpoint() is
// given (see its own resolve() call site) rather than baked into
// defaultResolver alone, so injected test resolvers are bounded the same
// way. Timing out falls back to the literal hostname rather than
// rejecting -- the same "availability over strictness" rule
// canonicalizeEndpoint() already applies to an outright resolver failure
// -- since a node on a slow-to-resolve name must still be registerable,
// just under the weaker string-based identity.
const DNS_LOOKUP_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DNS lookup exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

const defaultResolver: HostResolver = async (hostname) => {
  const { address } = await dns.lookup(hostname);
  return address;
};

// node:net's isIP() is deliberately not used here -- it isn't on this
// project's permitted-module list for the coordinator (node:http, node:test,
// node:assert/strict, node:crypto, node:dns, fetch, AbortSignal.timeout).
// A DNS hostname can never legally contain a colon, so "does the host
// contain ':'" is a sufficient (if not RFC-strict) signal that it's an
// IPv6 literal rather than a name to resolve.
function isIPv4Literal(host: string): boolean {
  return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host);
}

function isIPv6Literal(host: string): boolean {
  return host.includes(":");
}

// Loopback means: true SYNONYMS for one specific address -- 127.0.0.1,
// ::1, 0.0.0.0 (which every common OS treats as "this host" for a connect
// target, the same way it's treated as "every interface" for a bind
// target), an IPv4-mapped-IPv6 spelling of 127.0.0.1, or the literal
// hostname "localhost". This is deliberately NARROWER than "any IPv4 in
// 127.0.0.0/8": that broader rule was this project's own first attempt,
// and whole-branch review live-verified it collapsing 127.0.0.1 and
// 127.0.0.2 -- two genuinely DIFFERENT bind addresses that can host two
// completely unrelated real processes -- into one identity for free, no
// DNS trickery needed. That gratuitous collision was never required to
// fix Phase C's actual bug (one machine reachable as both 127.0.0.1 and
// localhost); it only widened the attack surface NodeRegistry.register()'s
// endpoint-pinning fix (see its own comment) now has to defend against.
// Every other loopback IP in 127.0.0.0/8 canonicalizes as itself, exactly
// like any other ordinary address -- a real, distinguishable identity, not
// folded into everyone else's.
export function isLoopbackAddress(address: string): boolean {
  if (address === "127.0.0.1" || address === "::1" || address === "0.0.0.0" || address === "localhost") {
    return true;
  }
  // IPv4-mapped IPv6 forms of 127.0.0.1 specifically (RFC 4291 §2.5.5.2) --
  // an exact numeric synonym, not a "nearby" address, so recognizing it
  // does not reopen the /8-collapse problem above. Node's URL parser
  // normalizes the WHATWG-legal dotted-quad tail spelling
  // ("::ffff:127.0.0.1") to pure hex groups ("::ffff:7f00:1", since
  // 0x7f000001 splits into the 16-bit words 0x7f00 and 0x0001) before this
  // function ever sees it, so that is the form actually checked for; the
  // dotted-quad string is also recognized directly in case a resolver or
  // test hands one in un-normalized.
  return address === "::ffff:127.0.0.1" || address === "0:0:0:0:0:ffff:127.0.0.1" ||
         address === "::ffff:7f00:1" || address === "0:0:0:0:0:ffff:7f00:1";
}

// Canonicalizes an endpoint URL to a `host:port` identity key. The same
// physical listening socket produces the same key no matter which alias
// string (loopback form, DNS name, trailing-dot FQDN) was used to reach
// it -- see the design doc's Mechanism 1 for the full reasoning and the
// deliberate choice to pair this with endpoint-authoritative registration
// (Mechanism 2) rather than ship it alone.
//
// The identity key is NOT the contact URL: callers must keep using the
// original endpoint to make requests (an IP substitution here would break
// TLS SNI and name-based virtual hosting). This function only answers
// "is this the same machine as that one", never "how do I reach it".
export async function canonicalizeEndpoint(endpoint: string, resolve: HostResolver = defaultResolver): Promise<string> {
  const url = new URL(endpoint); // throws TypeError for anything unparseable -- this function's own contract

  let hostname = url.hostname.toLowerCase();
  // IPv6 literals come back bracketed ("[::1]") from URL.hostname; strip the
  // brackets so isIPv6Literal/isLoopbackAddress see the bare address.
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  // A single trailing dot is a legal, equivalent DNS spelling of the same
  // name ("example.com." === "example.com") -- strip exactly one. Guarded
  // on "no colon" so this never touches an IPv6 literal's own punctuation.
  if (!hostname.includes(":") && hostname.endsWith(".")) {
    hostname = hostname.slice(0, -1);
  }

  const port = url.port !== "" ? url.port : (url.protocol === "https:" ? "443" : "80");

  let address: string;
  if (hostname === "localhost" || isIPv4Literal(hostname) || isIPv6Literal(hostname)) {
    // Already a canonical machine reference -- no DNS involved, so a spy
    // resolver configured to throw if called (this project's tests use
    // exactly that) never fires for it.
    address = hostname;
  } else {
    try {
      // Timeout-wrapped here rather than inside defaultResolver, so the
      // same bound applies uniformly to the default resolver and to any
      // injected one -- this function is what owns the "must complete in
      // reasonable time" contract, not whichever resolver it's handed.
      address = await withTimeout(resolve(hostname), DNS_LOOKUP_TIMEOUT_MS);
    } catch {
      // Availability over strictness (design doc, Mechanism 1, step 5): a
      // node on a name this coordinator cannot resolve -- or one whose
      // resolution hangs past DNS_LOOKUP_TIMEOUT_MS -- must still be
      // registerable. It just keeps the weaker, string-based identity.
      address = hostname;
    }
  }

  if (isLoopbackAddress(address)) {
    address = "loopback";
  }

  return `${address}:${port}`;
}
