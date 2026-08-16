# Phase D: Token Streaming — Design

> Forward-looking design, written before any implementation. Independent
> of Phases B and C — streaming changes *how* a response is delivered, not
> *which* nodes serve it, so this could in principle be built before or
> after B/C without much interaction. Written last because it's the least
> urgent (Phase A's blocking response is a real, disclosed limitation, but
> a working non-streaming path was correctly prioritized as the actual
> milestone).

## Summary

`swarm::InferenceEngine::complete()` is fully synchronous: it runs the
entire generation loop internally and returns one finished string. Every
layer built so far — `swarm-node-agent`'s `/complete`, the coordinator's
`/generate`, `SwarmClient.generate()`, the web dashboard — inherits that
all-or-nothing shape: a caller waits for the complete response or gets an
error, with no partial output ever visible. Phase D changes this to real
token-by-token streaming, end to end.

This touches every layer built in Plans 1 through 13, which is why it's
scoped as its own phase rather than a quick addition: it's a genuine
protocol change (blocking → streaming) at each of four boundaries (engine
→ agent, agent → coordinator, coordinator → client, client → UI).

## Goals

- `InferenceEngine` gains a way to observe tokens as they're generated,
  not only the final concatenated string.
- `swarm-node-agent`'s `/complete` (or a new streaming-specific endpoint)
  delivers tokens to the coordinator as they're produced, not after
  generation finishes.
- The coordinator's `/generate` relays the stream to its caller instead of
  buffering the full response before replying.
- `SwarmClient.generate()` and the web dashboard can consume a stream and
  render partial output as it arrives.

## Non-Goals

- **Changing the non-streaming path.** `POST /complete` and `POST
  /generate`'s existing blocking behavior should very likely remain
  available (as a default or as an explicit opt-out) for callers that
  don't need streaming and prefer the simpler request/response shape —
  removing it would be a breaking change to everything built so far for
  no clear benefit. Treat streaming as additive.
- **Speculative decoding integration.** `complete_speculative()` already
  exists and is unrelated to this phase's scope; whether/how to stream
  speculative output is a real question but a separate one — don't fold
  it into this design.
- **Cancellation mid-stream.** A client disconnecting mid-generation
  today (verified live during Plan 12's whole-branch review) leaves the
  agent finishing its work with nobody listening — Phase D doesn't need
  to solve early-cancellation-stops-generation as part of the initial
  streaming design, though it's a natural, disclosed follow-up.

## Architecture, Boundary by Boundary

### 1. `InferenceEngine` (C++)

Needs a callback-based (or generator-style) variant of `complete()`, e.g.:

```cpp
// Calls onToken(text) once per generated token, in order, as it's
// produced. Returns once generation finishes (n_predict reached or
// end-of-generation). onToken returning false requests early stop.
void completeStreaming(const std::string& prompt, int n_predict,
                        const std::function<bool(const std::string&)>& onToken);
```

This is a real, non-trivial C++ change — it means restructuring
`complete()`'s internal decode loop to yield per-token rather than
accumulate-then-return. The existing `complete()` could become a thin
wrapper that calls `completeStreaming()` with a callback that just
concatenates, preserving its exact current behavior and test coverage
rather than duplicating the decode loop.

### 2. `swarm-node-agent` (C++, HTTP)

The hand-rolled `HttpServer` (Plan 12) currently writes one full response
per request (`Content-Length` known upfront, connection closed after).
Streaming needs either **chunked transfer encoding** (no upfront
`Content-Length`, a series of length-prefixed chunks, a terminating
zero-length chunk) or **Server-Sent Events** (`Content-Type:
text/event-stream`, a series of `data: ...\n\n` lines, connection held
open). SSE is the better fit here: it's simpler to implement correctly by
hand (append-only text lines, vs. chunked encoding's binary length
prefixes), and it's natively consumable by browser `EventSource` on the
client end (relevant for the web dashboard). This means extending
`HttpServer` itself to support a "keep the connection open, write
multiple times" response mode — a real addition to code that was
carefully reviewed and hardened (SIGPIPE handling, bounded reads) for a
single-request-single-response model; that hardening needs re-examination
for a long-lived-connection model, not just extended.

### 3. Coordinator `/generate` (Node.js)

Node's `http` module already supports streaming responses natively
(`res.write()` multiple times before `res.end()`) — no new dependency
needed, consistent with this project's zero-npm-dependency posture. The
coordinator needs to switch from its current "await the full fetch
response, then send one JSON reply" pattern to consuming the agent's SSE
stream and relaying each token to its own caller as it arrives (either
also as SSE, or as chunked JSON lines — pick one consistent wire format
for `SwarmClient` to consume).

**Real design question:** the safety classifier currently runs once,
upfront, on the whole prompt, before any node is even selected — that part
is unaffected by streaming (nothing about the response changes the
classify step). But error handling changes: today, if the selected node
fails, `/generate` returns a clean `502` because nothing has been sent to
the caller yet. With streaming, some tokens may already have been
delivered before a mid-stream failure — the protocol needs a defined way
to signal "generation failed partway through" *after* a `200` and some
real content already went out, which is a fundamentally different error
model than today's single-shot success-or-4xx/5xx.

### 4. `SwarmClient` / web dashboard

`SwarmClient.generate()` currently returns `Promise<{text: string}>`.
A streaming variant needs a different shape — likely an async generator
(`for await (const token of client.generateStream(...))`) or a callback
parameter, consistent with how `EventSource`/`ReadableStream` are
idiomatically consumed in this project's target runtime (Node.js's native
`fetch` returns a `ReadableStream` body, so this is buildable without a
new dependency). The web dashboard's `/classify` demo already shows the
established pattern for wiring a button to an async call and updating the
DOM — a streaming version would append incrementally instead of
replacing the result text once, but the plumbing is not fundamentally new
to the dashboard, most of the new complexity is upstream of it.

## Known Risks

- This is a genuinely bigger change than any single plan built so far in
  this project — it touches four independently-designed layers, three of
  which were built and hardened around a request/response model, not a
  streaming one. Consider whether this warrants splitting into per-layer
  plans (mirroring how Phase A's C++ and coordinator halves were split
  into Plans 12/13) rather than one large plan, when this is picked up.
- `HttpServer`'s SIGPIPE/bounded-read/single-response hardening (Plan 12)
  was specifically reviewed and fixed against a "one request, one
  response, then close" model. A long-lived streaming connection changes
  the failure modes that hardening was built for (e.g., what does a
  bounded 16 KiB header cap or a 10 MiB body cap mean for a connection
  that's now open for the duration of a long generation, not a single
  quick exchange?) — re-review, don't assume the existing hardening
  transfers unchanged.
- No load-bearing precedent exists yet in this repo for a Node.js↔C++
  streaming HTTP relay under real network conditions (only synchronous
  request/response has been tested, and only on localhost) — budget real
  testing time for this, not just unit tests.

## Testing Considerations

- Needs a genuine, non-mocked streaming test at each boundary, following
  this project's established pattern (Plan 12's real subprocess+model
  integration test, Plan 13's real end-to-end test) — a test that only
  checks "the final concatenated text matches" without checking that
  tokens actually arrived incrementally would miss the entire point of
  this phase and wouldn't have caught anything a non-streaming test
  couldn't already catch.
- Needs a live-adversarial-probing whole-branch review, per this
  project's established and consistently bug-finding practice — a client
  disconnecting mid-stream, a node crashing mid-stream (the same
  uncatchable `GGML_ABORT`-on-dead-remote-device failure mode named in
  Phase A's known limitations, now happening *after* a `200` and partial
  content have already been sent instead of before anything was sent),
  and concurrent streaming requests against the still-single-threaded
  agent are the obvious places to probe first.
