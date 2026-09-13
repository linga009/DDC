import { promises as dns } from "node:dns";

// Injectable, same idiom as NodeRegistry's `clock` (coordinator/src/registry.ts)
// -- tests script a fake resolver instead of touching real DNS.
export type HostResolver = (hostname: string) => Promise<string>;

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

// Loopback means: ::1, an IPv4 address in 127.0.0.0/8, or the literal
// hostname "localhost" -- the single most common real-world alias set,
// and the one that produced Phase C's launcher wrong-model-served bug
// (one machine reachable as both 127.0.0.1 and localhost).
export function isLoopbackAddress(address: string): boolean {
  if (address === "::1" || address === "localhost") {
    return true;
  }
  const match = address.match(/^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  return match !== null && Number(match[1]) === 127;
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
      address = await resolve(hostname);
    } catch {
      // Availability over strictness (design doc, Mechanism 1, step 5): a
      // node on a name this coordinator cannot resolve must still be
      // registerable. It just keeps the weaker, string-based identity.
      address = hostname;
    }
  }

  if (isLoopbackAddress(address)) {
    address = "loopback";
  }

  return `${address}:${port}`;
}
