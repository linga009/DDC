# Phase D: Token Streaming — Implementation Design

## Background

This supersedes/elaborates the original forward-looking sketch at
[`docs/superpowers/specs/2026-08-16-phase-d-token-streaming-design.md`](docs/superpowers/specs/2026-08-16-phase-d-token-streaming-design.md),
written before any of Phases B/C/D existed and explicitly marked as needing
re-validation against the actual codebase at planning time (per `CLAUDE.md`'s
standing instruction for all three of those designs). That doc's Summary,
Goals, and per-boundary sketch are still correct in shape; this doc grounds
every claim against the real current source (`core/src/inference_engine.cpp`,
`core/include/swarm/http_server.h`, `core/src/http_server.cpp`,
`coordinator/src/server.ts`, `coordinator/src/client.ts`,
`coordinator/public/app.js` — all read fresh, not from memory, as of
2026-08-22) and resolves the original doc's open architectural sketch into
concrete signatures.

This work was picked up ahead of a separate, still-pending plan (adding an
OpenAI-compatible `/v1/chat/completions` endpoint to the coordinator) once
it became clear that plan's "real streaming" requirement meant implementing
Phase D as a prerequisite, not a small addition — Phase D's own known scope
(four boundaries, two tech stacks) is why it was deferred as its own phase
in the first place. Chosen to build as one plan spanning all four layers
(not split per-layer, unlike Phase A's Plan 12/13 precedent) — a deliberate
choice, not an oversight; see Rejected Approaches.

Confirmed still true by reading the current code directly: `complete()`'s
decode loop *does* already break early on the model's own end-of-generation
token (`llama_vocab_is_eog`) — this project's own dashboard chat interface
saw runaway generation past a sensible answer not because early-stop is
missing, but because raw-completion prompting (no chat template exists
anywhere in `core/`) rarely shapes input in a way that reliably triggers a
model's EOG token. This matters for streaming: the existing early-stop
behavior must be preserved exactly, not treated as something to add.

## Goals

- `InferenceEngine` gains a callback-based way to observe tokens as they're
  generated, without duplicating or diverging from `complete()`'s existing
  decode loop, tokenization, sampling, or EOG-detection behavior.
- `swarm-node-agent`'s `POST /complete` gains an optional `stream: true`
  request field that delivers generated text to the coordinator as SSE
  chunks, as it's produced, instead of one JSON body after generation
  finishes.
- The coordinator's `POST /generate` gains the same optional `stream: true`
  field, relaying the node's SSE stream to its own caller as it arrives
  rather than buffering the full response first.
- `SwarmClient` gains a streaming consumption method, and the just-shipped
  dashboard chat panel renders tokens incrementally instead of showing
  nothing until the full reply lands.
- `/complete` and `/generate`'s existing non-streaming behavior is
  unchanged and remains the default — every existing test, and every
  existing caller that never passes `stream: true`, continues to work
  exactly as today.

## Non-Goals

- **Cancellation.** A client disconnecting mid-stream still leaves the node
  finishing generation with nobody listening — the same pre-existing,
  disclosed behavior as today's non-streaming path (verified live during
  Plan 12's whole-branch review), not newly introduced or newly fixed by
  this phase.
- **Speculative decoding streaming.** `complete_speculative()` is untouched
  by this design; whether/how to stream its output is a separate, real
  question for a future phase.
- **Sampling parameter support** (`temperature`, `top_p`, etc.). The
  engine's sampler is greedy-only today (`llama_sampler_init_greedy()`,
  confirmed by reading `complete()`) — unrelated to streaming, not changed
  here.
- **The OpenAI-compatible endpoint itself.** This phase only builds the
  streaming plumbing; wiring an OpenAI-shaped `/v1/chat/completions` on top
  of it (real streaming *and* real token counts, both now possible once
  this lands) is a separate, already-sketched plan, deliberately sequenced
  after this one.
- **Real token counts in this phase's own deliverable.** `n_prompt_tokens`
  and a generated-token counter are both already local variables inside
  `complete()`'s current implementation and trivially returnable — but
  exposing them is the OpenAI-compat plan's concern, not this one's; this
  phase's `completeStreaming()` returns generated text only, not counts.
  (Whoever picks up the OpenAI-compat plan next should note this: threading
  counts through is a small, obvious follow-on once `completeStreaming()`
  exists, not a reason to duplicate work here.)

## Architecture

### 1. `InferenceEngine` (`core/include/swarm/inference_engine.h`, `core/src/inference_engine.cpp`)

Current `complete()` (full text below, exactly as it reads today):

```cpp
std::string InferenceEngine::complete(const std::string& prompt, int n_predict) {
    llama_memory_clear(llama_get_memory(ctx_), true);
    const llama_vocab* vocab = llama_model_get_vocab(model_);
    const int n_prompt_tokens = -llama_tokenize(
        vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), nullptr, 0, true, true);
    std::vector<llama_token> prompt_tokens(n_prompt_tokens);
    if (llama_tokenize(
            vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()),
            prompt_tokens.data(), static_cast<int32_t>(prompt_tokens.size()),
            true, true) < 0) {
        throw std::runtime_error("failed to tokenize prompt");
    }
    if (prompt_tokens.size() > static_cast<size_t>(llama_n_batch(ctx_))) {
        throw std::runtime_error("prompt too long: " + std::to_string(prompt_tokens.size()) +
                                 " tokens exceeds batch size " + std::to_string(llama_n_batch(ctx_)));
    }

    llama_sampler_chain_params sampler_params = llama_sampler_chain_default_params();
    llama_sampler* sampler = llama_sampler_chain_init(sampler_params);
    llama_sampler_chain_add(sampler, llama_sampler_init_greedy());

    llama_batch batch = llama_batch_get_one(
        prompt_tokens.data(), static_cast<int32_t>(prompt_tokens.size()));

    std::string result;
    llama_token new_token;
    int n_generated = 0;

    while (n_generated < n_predict) {
        if (llama_decode(ctx_, batch) != 0) {
            llama_sampler_free(sampler);
            throw std::runtime_error("llama_decode failed");
        }
        new_token = llama_sampler_sample(sampler, ctx_, -1);
        if (llama_vocab_is_eog(vocab, new_token)) {
            break;
        }
        char piece[128];
        int n = llama_token_to_piece(vocab, new_token, piece, sizeof(piece), 0, true);
        if (n < 0) {
            llama_sampler_free(sampler);
            throw std::runtime_error("failed to convert token to text");
        }
        result.append(piece, n);
        batch = llama_batch_get_one(&new_token, 1);
        n_generated += 1;
    }

    llama_sampler_free(sampler);
    return result;
}
```

Note the manual `llama_sampler_free(sampler)` duplicated at both throw sites
and the normal-return site — a leak-shaped pattern any restructuring of this
loop risks getting wrong. New header declaration:

```cpp
// Calls onToken(piece) once per generated token's text, in order, as each
// is produced -- exact same tokenization, sampling, batching, and
// end-of-generation detection as complete(). onToken returning false
// requests early stop (checked after each token, same effect as reaching
// n_predict or hitting EOG). Throws exactly the exceptions complete() would
// (failed tokenization, prompt too long, decode failure, token-to-text
// failure), before any callback has fired for a pre-generation failure, or
// after the last successful callback for a mid-generation one.
void completeStreaming(const std::string& prompt, int n_predict,
                        const std::function<bool(const std::string&)>& onToken);
```

Implementation: identical setup (memory clear, tokenize, batch-size check,
sampler construction) to `complete()` today. A small RAII wrapper around the
sampler (e.g. a local struct whose destructor calls `llama_sampler_free`)
replaces the two duplicated manual-free call sites — a directly-motivated
cleanup, not unrelated refactoring, since restructuring this exact loop is
where a callback-early-return or callback-throwing path could otherwise leak
the sampler in a way the current code's two manual frees don't fully cover.
Inside the loop, after computing `piece`/`n` exactly as today, call
`onToken(std::string(piece, n))` instead of appending to a local `result`;
if it returns `false`, break the loop (mirrors the existing EOG break).

`complete()` becomes:

```cpp
std::string InferenceEngine::complete(const std::string& prompt, int n_predict) {
    std::string result;
    completeStreaming(prompt, n_predict, [&result](const std::string& piece) {
        result.append(piece);
        return true;
    });
    return result;
}
```

Preserves `complete()`'s exact existing signature, behavior, and — since the
decode loop itself only moves, doesn't change — its existing test coverage
in `core/tests/inference_engine_test.cpp` should need zero changes.

### 2. `HttpServer` (`core/include/swarm/http_server.h`, `core/src/http_server.cpp`)

Current contract (confirmed by reading both files fresh): `HttpHandler =
std::function<HttpResponse(const HttpRequest&)>` — a handler synchronously
computes and returns one complete `{status, body}`; `writeResponse()` then
sends `HTTP/1.1 <status>`, a `Content-Length` computed from the *already
fully materialized* body string, `Connection: close`, and the body, in one
blocking send loop, before the caller closes the socket. There is
structurally no way for a handler with this signature to write output
before its return value exists. The header's own comment says: *"This
exists to be one process's small, fixed local API surface, not a
general-purpose web server — do not extend it toward one."* This design is
a deliberate, acknowledged exception to that stated intent — worth saying
so explicitly in the updated header comment, not silently working around
it.

New parallel handler type and registration method, alongside the existing
`route()`/`HttpHandler` (both keep working exactly as today for every
non-streaming route — including every route registered before this phase,
zero behavior change):

```cpp
// Handed to a StreamingHttpHandler after this server has already sent SSE
// response headers (200, Content-Type: text/event-stream, Connection:
// close -- the connection still closes when the handler returns or throws,
// this is NOT persistent multi-request keep-alive, just one long-lived
// single-response stream). writeChunk() sends one `data: <text>\n\n` SSE
// frame per call, escaping embedded newlines in `text` (SSE frames are
// newline-delimited) so a multi-line generated chunk can't corrupt the
// stream framing. writeError() sends one `event: error\ndata:
// <json>\n\n` frame -- the defined way to signal "generation failed after
// some real content already went out", which a plain HTTP status code
// cannot do once headers are already sent. Both throw if the underlying
// send fails (peer gone), matching writeResponse()'s existing "n <= 0:
// nothing more we can do" reasoning, but as an exception the calling
// StreamingHttpHandler can choose to catch (e.g. to still free engine
// resources) rather than a silently swallowed return.
class ResponseWriter {
public:
    void writeChunk(const std::string& text);
    void writeError(const std::string& message);
private:
    socket_t socket_;
    // constructed only by HttpServer, which owns the socket lifetime
};

using StreamingHttpHandler = std::function<void(const HttpRequest&, ResponseWriter&)>;

// Registers a streaming handler for an exact (method, path) pair, checked
// against the same routes_ table as route() -- a (method, path) already
// registered via route() or routeStreaming() cannot be registered again
// via either (first registration wins, matching route()'s existing
// first-match-wins contract, now enforced across both tables together).
void routeStreaming(const std::string& method, const std::string& path, StreamingHttpHandler handler);
```

`run()`'s per-connection dispatch: after matching `(method, path)` as today,
check the streaming table first (or store a single tagged-variant table
instead of two parallel ones — implementer's call, both satisfy this
design), and take the `ResponseWriter` path instead of `writeResponse()`
when matched there.

**Hardening re-review, not just extension** (per the original design doc's
flagged risk, confirmed still relevant by reading the current bounded-read
logic): the existing 16 KiB header cap and 10 MiB body cap were sized and
reviewed for one quick request/response exchange. A streaming response
holds the connection open for the duration of a real generation (seconds to
minutes, per this project's existing `GENERATE_TIMEOUT_MS` = 120000
precedent at the coordinator layer) — re-examine whether those caps, and
the SIGPIPE-ignore posture, still mean what they meant when this code was
last reviewed, rather than assuming a long-lived write loop inherits the
same safety properties as a single blocking send.

### 3. `swarm-node-agent`'s `POST /complete` (`core/src/node_agent_main.cpp`)

Gains an optional `stream` boolean field on the existing request body
(alongside the existing `prompt`/`n_predict`) rather than a new URL — one
endpoint, mode-switched by a field, consistent with what the coordinator
(and, later, the OpenAI-compat plan) will both want. When absent or
`false`: registered via the existing `route()`, behavior byte-identical to
today. When `true`: registered via the new `routeStreaming()`, calls
`engine->completeStreaming(prompt, nPredict, onToken)` with a callback that
calls `writer.writeChunk(piece)` per token; a thrown exception from
`completeStreaming()` (including the known dead-remote-RPC-device
`GGML_ABORT` case named in Phase A's disclosed limitations) is caught and
turned into one `writer.writeError(...)` frame before the connection
closes, rather than an uncaught exception or a silently dropped connection.

### 4. Coordinator `POST /generate` (`coordinator/src/server.ts`)

Gains the same optional `stream` boolean field. The existing
classify-then-`selectNode` sequence is entirely unaffected and runs first,
exactly as today, regardless of `stream`'s value — nothing about streaming
changes when or whether a prompt gets classified or which node gets picked.
When `stream` is true: the outbound `fetch` to the node's `/complete` also
sends `stream: true`; instead of `await res.json()`, the handler sets SSE
response headers on its own `res` and consumes the node's response body via
Node's native `fetch()` `ReadableStream` (already available with zero new
dependencies, matching this project's existing constraint), relaying each
decoded chunk onward as its own `data: ...\n\n` frame to its caller. A
`event: error` frame arriving from the node is relayed onward the same way,
not swallowed. `res.write()` (Node's `http` module, already used
implicitly via `sendJson`'s `res.writeHead`/`res.end`) needs no new
dependency either.

### 5. `SwarmClient` (`coordinator/src/client.ts`) + dashboard (`coordinator/public/app.js`)

`client.ts` gains:

```typescript
async *generateStream(prompt: string, modelId: string, n_predict?: number, signal?: AbortSignal): AsyncGenerator<string> {
  // Consumes the coordinator's SSE response body via fetch()'s
  // ReadableStream, yielding one decoded chunk's text per `data: ...`
  // frame; throws if an `event: error` frame arrives, with that frame's
  // message.
}
```

...consumed as `for await (const piece of client.generateStream(...))`. The
dashboard's just-shipped `sendChatMessage()` (`coordinator/public/app.js`)
switches from `const body = await res.json()` to this generator, appending
each `piece` to the in-progress assistant message's rendered text as it
arrives instead of waiting for one complete `body.text` — the existing
"Thinking…" placeholder becomes genuinely live partial output rather than a
static label removed only once everything is ready. `authedFetch`'s
existing token-header logic is reused unchanged (SSE over a normal
authenticated `fetch()` call, no new auth mechanism).

## Rejected Approaches

- **Splitting into per-layer plans** (mirroring Phase A's Plan 12/13
  split, and the original design doc's own suggestion to consider this).
  Explicitly rejected for this pass: one plan across all four layers,
  chosen deliberately when scoping this work — see Background. Named here
  so a future reader doesn't assume it was an oversight.
- **Chunked transfer encoding instead of SSE**, between node-agent and
  coordinator. Rejected for the same reason the original design doc gave:
  simpler to hand-implement correctly (append-only text frames vs. binary
  length-prefixed chunks) and natively useful for a browser client later,
  even though the coordinator↔dashboard hop here uses `fetch()`'s
  `ReadableStream` rather than `EventSource` (which can't send the
  `Authorization` header this project's auth model requires) — SSE's
  *framing*, not `EventSource` specifically, is the reused piece.
  Standardizing on SSE at every hop (agent→coordinator, coordinator→client)
  also means the deferred OpenAI-compat plan's own streaming requirement
  (real OpenAI wire format *is* SSE) gets the same format for free later,
  not a second translation layer.
- **A separate `/complete/stream` and `/generate/stream` URL**, instead of
  a `stream` body field on the existing routes. Rejected: doubles the
  routes to maintain for identical logic modulo response shape, and the
  field-based approach is what the deferred OpenAI-compat plan's `stream:
  true` (matching real OpenAI's own convention) will want to reuse
  directly at the coordinator layer.

## Open Questions

- **Bounded-read/SIGPIPE re-review's exact new limits** are not decided by
  this doc — flagged as required work in Architecture #2, but the actual
  new cap values (if any change is even needed) are an implementation-time
  decision informed by testing against a real long-lived stream, not a
  design-time one.
- **`ResponseWriter`'s exact SSE line-escaping strategy** for a generated
  piece containing an embedded `\n` (a real, expected case — generated text
  routinely contains newlines) is sketched only at the level of "must not
  corrupt SSE framing" above; the precise escaping (e.g. multiple `data:`
  lines per SSE event, one per source line, per the SSE spec's own
  multi-line convention) is implementation detail for the plan, not
  re-derived here.

## Testing Considerations

- `core/tests/inference_engine_test.cpp`: new tests for `completeStreaming()`
  directly — confirms tokens arrive incrementally (a callback invocation
  count `>= 1` and `<= n_predict`, called before the function returns, not
  just that the final concatenation matches `complete()`'s own output for
  the same prompt/seed) — a test that only checks the final string
  wouldn't prove anything a non-streaming test couldn't already prove.
  Existing `complete()` tests should need zero changes (behavior-preserving
  wrapper).
- `core/tests/http_server_test.cpp`: real streaming HTTP round-trip against
  a `routeStreaming()`-registered handler — confirms multiple `writeChunk`
  calls arrive as separate readable frames on a real socket, not
  coalesced/reordered, and that `writeError` after partial output is
  distinguishable from a clean end-of-stream.
- `coordinator/tests/server.test.ts`: HTTP-level test for `/generate`'s
  `stream: true` path against a real stub node agent emitting multiple SSE
  chunks — confirms the coordinator relays them incrementally (not
  buffered-then-flushed-at-once) and that a stub-emitted `event: error`
  frame reaches the caller.
- Live-adversarial-probing whole-branch review (per this project's
  established, consistently bug-finding practice for exactly this kind of
  change): a real node process killed mid-stream (the disclosed
  `GGML_ABORT`-on-dead-remote-device case, now happening *after* a `200`
  and partial content instead of before anything was sent), a client
  aborting the fetch mid-stream (confirm the node/agent side doesn't hang
  or crash — even though cleanly stopping generation early is a Non-Goal,
  the connection teardown itself must not misbehave), and concurrent
  streaming requests against the still-single-threaded agent.
- Manual, live-browser verification of the dashboard's incremental
  rendering (this project's established pattern for UI changes, most
  recently used for the chat panel itself) — confirming text visibly
  appears progressively, not in one jump at the end.
