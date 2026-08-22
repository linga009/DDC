# OpenAI-Compatible Endpoint — Implementation Design

## Background

Deferred from earlier in this project's history, and explicitly sequenced
after Phase D (token streaming) once it became clear this plan's own "real
streaming, real token counts, not estimates" requirement (the user's own
words, stated when this plan was first scoped) meant Phase D's plumbing was
a genuine prerequisite, not a nice-to-have — see Phase D's own design doc
(`docs/superpowers/specs/2026-08-22-phase-d-token-streaming-implementation-design.md`),
Non-Goals: *"The OpenAI-compatible endpoint itself... is a separate,
already-sketched plan, deliberately sequenced after this one"* and *"Real
token counts... exposing them is the OpenAI-compat plan's concern... a
small, obvious follow-on once `completeStreaming()` exists."* Phase D is
now merged and live on `master`. This doc grounds every claim against the
real current source (`coordinator/src/server.ts`, `coordinator/src/client.ts`,
`coordinator/src/catalog.ts`, `coordinator/public/app.js`,
`core/include/swarm/inference_engine.h`, `core/src/inference_engine.cpp`,
`core/src/node_agent_main.cpp`, `core/include/swarm/http_server.h`,
`core/src/http_server.cpp` — all read fresh as of 2026-08-22, not from
memory), per this project's own established convention.

**Purpose:** external OpenAI-API-compatible tools (`deepseek-harness`, Open
WebUI, LangChain, and any other client written against the real OpenAI
Chat Completions API) should be able to point at this coordinator as a
drop-in model provider.

**Confirmed genuinely unbuilt** (grepped the whole repo): no route, file,
or symbol named `openai`, `v1`, `chat/completions`, or a `/v1/models`
endpoint exists anywhere in `coordinator/src/**` or `core/src/**`. The only
prior references are the sequencing notes in Phase D's own design/plan
docs and a few comments noting the `[DONE]` SSE sentinel already matches
OpenAI's convention — never an implementation.

## Goals

- `POST /v1/chat/completions` — accepts OpenAI's `{model, messages, stream?,
  max_tokens?, ...}` request shape, routes through this coordinator's
  existing classify → reputation-rank → select-node → forward pipeline
  (the exact same pipeline `/generate` already uses — reused, not
  duplicated), and returns a real OpenAI-shaped `chat.completion` response
  (non-streaming) or a real OpenAI-shaped `chat.completion.chunk` SSE
  stream (`stream: true`), in both cases with **real token counts** —
  `prompt_tokens`/`completion_tokens` computed by the C++ engine during the
  actual tokenize/generate call, not estimated by word-splitting or any
  other heuristic — and a real `finish_reason` (`"stop"` when the model's
  own end-of-generation token fired, `"length"` when the token cap was
  hit).
- `GET /v1/models` — lists the model catalog in OpenAI's `{object: "list",
  data: [...]}` shape, so an OpenAI-compatible client's model picker works
  against this swarm without modification.
- `InferenceEngine` gains a way to report the two real counts (and which
  way generation stopped) to a caller that wants them, without touching
  `complete()`'s or `completeStreaming()`'s existing signatures, callers,
  or behavior in any way.
- `swarm-node-agent`'s `POST /complete` gains these counts in its response
  — unconditionally for the non-streaming case (purely additive JSON
  fields), and behind a new opt-in request field for the streaming case
  (see Architecture #2 for why streaming needs to be opt-in and
  non-streaming doesn't).
- Existing `/generate`, `SwarmClient`, and the dashboard chat panel are
  **completely unmodified** by this plan — the new endpoints are additive
  and parallel, not a replacement or a refactor of the existing pipeline.

## Non-Goals

- **Sampling parameter support.** The engine is greedy-only
  (`llama_sampler_init_greedy()`, confirmed unchanged by Phase D). A
  request setting `temperature`, `top_p`, `presence_penalty`, etc. is
  accepted (not rejected — real OpenAI-compatible clients routinely send
  these unconditionally) but **silently has no effect**. This must be
  disclosed prominently in README, the same way every other "accepted but
  not honored" gap in this project is named rather than hidden.
- **Tool calls / function calling.** `tools`, `tool_choice`,
  `function_call` and friends are not parsed or honored. A request
  containing them is not rejected (for the same compatibility reason
  above), but no tool-call machinery exists anywhere in this codebase and
  none is added here.
- **`n > 1` (multiple choices per request).** Every response has exactly
  one `choices[0]` entry. `n` in the request body, if present, is ignored.
- **Real chat-template awareness.** Confirmed unchanged by every prior
  plan touching this: no model-specific chat formatting exists anywhere in
  `core/`. `messages[]` is flattened into the same plain-text
  `"Role: content\n"` transcript convention the dashboard's
  `buildChatPrompt()` already uses (see Architecture #3) — reply quality
  depends entirely on how well the selected model continues that
  transcript, exactly as already disclosed for the dashboard chat panel.
- **A generic embeddings/completions (`/v1/completions`, `/v1/embeddings`)
  endpoint.** Only chat completions and model listing are in scope; this
  repo has no embedding model support at all.
- **Persisting or logging conversation history server-side.** Every
  request is independently stateless, exactly like `/generate` today — the
  caller resends full `messages[]` every time, same as the dashboard
  already does.

## Architecture

### 1. `InferenceEngine::completeStreaming()` gains three optional out-parameters

Read fresh (`core/src/inference_engine.cpp:155-222`): both counts already
exist as local variables inside the current implementation and are simply
never returned.

- `n_prompt_tokens` is computed at line 161-162 (the real tokenizer count,
  via the `-llama_tokenize(...)` negative-length idiom) — exact, not
  estimated.
- `n_generated` is declared at line 198, incremented once per emitted
  token at line 220, inside `while (n_generated < n_predict)` (lines
  200-221). The loop has exactly three exit paths: the `while` condition
  going false (token cap reached, `n_generated == n_predict`), the
  model's own EOG token firing (`break` at line 207, *before* that token
  is counted or passed to `onToken`), or the caller's `onToken` returning
  `false` (`break` at line 216, also before incrementing). In every case
  `n_generated`'s final value is `n_predict` if and only if the cap was
  the actual stopping reason — a caller doesn't need a fourth signal, just
  the comparison `completion_tokens >= n_predict` after the call.

Add three new trailing parameters, all defaulted to `nullptr` so every
existing call site (`complete()`'s wrapper, `swarm-node-agent`'s existing
non-counting call, every test) needs zero changes:

```cpp
void completeStreaming(const std::string& prompt, int n_predict,
                        const std::function<bool(const std::string&)>& onToken,
                        int* out_prompt_tokens = nullptr,
                        int* out_completion_tokens = nullptr,
                        bool* out_reached_token_limit = nullptr);
```

Implementation: immediately after the `while` loop (i.e. right before the
function's closing brace, covering all three exit paths uniformly):

```cpp
    if (out_prompt_tokens) *out_prompt_tokens = n_prompt_tokens;
    if (out_completion_tokens) *out_completion_tokens = n_generated;
    if (out_reached_token_limit) *out_reached_token_limit = (n_generated >= n_predict);
```

On any exception path (tokenization failure, prompt-too-long, decode
failure, token-to-text conversion failure) the out-parameters are never
written — the caller never sees stale/zero data represented as real,
because it never sees the out-parameters populated at all when generation
never got a usable result, matching this function's existing
"throws before any callback fired, or after the last successful one"
contract exactly.

`complete()` itself (`inference_engine.cpp:224-231`) is untouched — its
wrapper call to `completeStreaming()` simply doesn't pass the three new
arguments, so its own behavior (return type, callers, tests) is
byte-for-byte unchanged. `swarm-cli`'s `main.cpp` likewise needs zero
changes.

### 2. `swarm-node-agent`'s `POST /complete` gains real counts

Read fresh (`core/src/node_agent_main.cpp:172-233`): one
`routeStreaming("POST", "/complete", ...)` registration branches
internally on the existing `stream` bool.

**Non-streaming branch** (currently lines 205-213, `{"text": "..."}`
only): call the new out-param overload and unconditionally add the three
new fields — this is a purely additive JSON response shape change, safe
for the existing `/generate` non-streaming path, which only ever reads
`.text` (confirmed: `coordinator/src/server.ts:571`,
`typeof nodeBody.text !== "string"` is the only field it inspects):

```json
{"text": "...", "prompt_tokens": 12, "completion_tokens": 40, "finish_reason": "stop"}
```

`finish_reason` is `"stop"` or `"length"`, using OpenAI's own vocabulary
directly at this layer rather than inventing a parallel one — this project
already deliberately reuses OpenAI's exact terms elsewhere (the `[DONE]`
sentinel, the `stream` field name itself; see Phase D's own Rejected
Approaches section for why standardizing on the real wire conventions was
a deliberate choice, not an oversight) and there is no benefit to a
translation table for two states with an obvious canonical name apiece.

**Streaming branch is the harder case, and needs an opt-in field.** The
current wire format (established by Phase D, already shipped and consumed
by `SwarmClient.generateStream()` and the dashboard) is: zero or more
`data: <token>\n\n` frames, then either `data: [DONE]\n\n` (success) or
`event: error\ndata: {...}\n\n` (failure) — and **`/generate`'s existing
relay is a raw byte-for-byte passthrough** of whatever `/complete` sends
(`coordinator/src/server.ts:536-543`, confirmed unchanged). If a new
`event: usage\n...` frame were sent unconditionally on every streaming
`/complete` call, it would flow straight through `/generate`'s passthrough
to `SwarmClient.generateStream()` and the dashboard's own SSE loop —
**neither of which recognizes an `event: usage` frame today.** Tracing
`client.ts`'s exact parsing (`coordinator/src/client.ts`, current
`generateStream()`): a frame starting with anything other than
`"event: error"` falls through to the generic `data:`-line extraction,
which *would* match the `data: {...}` line inside a hypothetical
`event: usage` frame and yield the raw JSON payload as if it were literal
generated text — silently corrupting every existing streaming consumer.
This is exactly the kind of same-mechanism-new-consumer collision this
project's whole-branch reviews keep catching; catching it at design time
instead.

**Resolution: an opt-in request field, not an unconditional new frame type
— mirroring real OpenAI's own `stream_options.include_usage` design for
the identical reason.** `/complete`'s request body gains a new optional
`includeUsage` boolean (default `false`). When `stream: true` and
`includeUsage: true`, the handler sends one additional terminal frame
*after* the token loop completes and *before* returning (i.e. before
`HttpServer::run()`'s automatic `writeDone()` call fires):

```
event: usage
data: {"prompt_tokens":12,"completion_tokens":40,"finish_reason":"stop"}

```

When `includeUsage` is absent or `false` — which is every existing caller,
since neither `/generate` nor `SwarmClient`/the dashboard will ever be
changed to set it — the wire format is **byte-for-byte identical** to
today. Only the new `/v1/chat/completions` handler (Architecture #4) will
ever set `includeUsage: true`.

`ResponseWriter` (`core/include/swarm/http_server.h` /
`core/src/http_server.cpp`) gains one new method, mirroring `writeError()`'s
already-established `event: <type>\ndata: {...}\n\n` framing (the exact
same SSE "named event" mechanism, reused for a second event type instead
of inventing a new one) and `writeChunk()`'s existing terminal-state guard
(no-op if `doneSent_ || errorSent_ || jsonResponseSent_` — the stream
already ended):

```cpp
// Sends one terminal metadata frame -- "event: usage\ndata:
// {"prompt_tokens":N,"completion_tokens":M,"finish_reason":"stop"}\n\n" --
// intended to be called once, by a handler, after generation completes and
// before returning (i.e. before HttpServer::run()'s automatic writeDone()
// call). A silent no-op under the same terminal-state rules as
// writeChunk()/writeError() -- see the class comment. Throws
// std::runtime_error if the underlying send fails (peer gone).
void writeUsage(int promptTokens, int completionTokens, const std::string& finishReason);
```

### 3. `messages[]` → prompt string translation (`coordinator/src/chat_prompt.ts`, new file)

The dashboard's `buildChatPrompt()` (`coordinator/public/app.js:90-98`,
read fresh) already does almost exactly this transformation, but is not
directly reusable: it reads a module-global `chatHistory` closure variable
rather than taking a `messages[]` parameter, and it collapses every
non-`"user"` role into `"Assistant:"` (its ternary is
`m.role === "user" ? "User" : "Assistant"`) — harmless for the dashboard,
which only ever has `user`/`assistant` entries in `chatHistory`, but wrong
for a real OpenAI `messages[]` array that may contain a `system` role.
`app.js` is also a plain `<script>`-tag browser file with zero `import`
statements (confirmed, same as Phase D's Task 5 already established) — it
cannot import from a coordinator-side TS module, and this plan does not
attempt to unify them; `app.js` keeps its own independent copy for the
dashboard's specific use case, exactly as Phase D's Task 5 established for
its own SSE-parsing logic.

New, small, independently-testable module:

```typescript
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Flattens an OpenAI-shaped messages[] array into the same plain-text
// "Role: content" transcript convention the dashboard's buildChatPrompt()
// already uses -- this project has no chat-template support anywhere, so
// reply quality depends entirely on how well the selected model continues
// this transcript. A trailing "Assistant:" (no colon-space content) is
// appended unconditionally, prompting the model to continue as the
// assistant. Unlike the dashboard's own copy of this idea, a "system"
// message is rendered with its own "System:" label rather than collapsing
// into "Assistant:" -- the dashboard never has system messages in its own
// chatHistory, so this divergence was never exercised there.
export function buildPromptFromMessages(messages: ChatMessage[]): string {
  const label = (role: ChatMessage["role"]) =>
    role === "user" ? "User" : role === "system" ? "System" : "Assistant";
  const transcript = messages.map(m => `${label(m.role)}: ${m.content}`).join("\n");
  return (transcript ? transcript + "\n" : "") + "Assistant:";
}
```

### 4. Coordinator `POST /v1/chat/completions` (`coordinator/src/server.ts`)

Routed as `parts[0] === "v1" && parts[1] === "chat" && parts[2] === "completions"`
(3 segments), matching this file's existing manual `parts`-array dispatch
convention (no router library, per `CLAUDE.md`'s standing constraint).
**Requires the shared bearer token, same as every other live-data route**
— this is not one of the four public routes (`isPublicRoute` at
`server.ts:203-206`), unlike the static dashboard shell.

Request validation: `model` (string, `catalog.hasModel(model)`, same
pattern `server.ts:462` already uses for `/generate`'s `modelId`),
`messages` (non-empty array of `{role, content}` objects — `role` must be
one of `"system"|"user"|"assistant"`, `content` must be a string),
`stream` (optional bool), `max_tokens` (optional int, same
1..`MAX_N_PREDICT` validation `/generate` already applies to `n_predict`,
mapped 1:1). Every other OpenAI field (`temperature`, `top_p`, `n`,
`stream_options`, `tools`, ...) is read only where explicitly needed
(`stream_options.include_usage`, see below) and otherwise ignored, per the
Non-Goals section.

Pipeline (reusing `/generate`'s exact existing sequence, not duplicated):
`buildPromptFromMessages(messages)` → `classifier.classify(prompt)` (same
fail-closed posture, same `CLASSIFY_TIMEOUT_MS`) → 400 in OpenAI's own
error envelope shape if unsafe (see below) → `selectNode(registry.listActive(reputation), reputation, model, random)` → 503 if none → forward to
`${node.endpoint}/complete`.

**Non-streaming:** POST `{prompt, n_predict: maxTokens, includeUsage: false}`
(streaming not requested from the node either), read the node's
`{text, prompt_tokens, completion_tokens, finish_reason}`, respond:

```json
{
  "id": "chatcmpl-<uuid>",
  "object": "chat.completion",
  "created": 1755878400,
  "model": "tinyllama-1.1b",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 12, "completion_tokens": 40, "total_tokens": 52 }
}
```

**Streaming (`stream: true`):** POST `{prompt, n_predict: maxTokens,
stream: true, includeUsage: true}` to the node. Unlike `/generate`, this
handler **cannot** do a raw byte passthrough — the wire *shapes* differ
(internal frames carry raw token text; OpenAI's wire format wraps each
token in a `chat.completion.chunk` JSON envelope) — so it must parse the
node's SSE stream and re-emit its own. This is a deliberate, necessary
departure from `/generate`'s raw-passthrough design (documented here so a
future reader doesn't mistake it for an inconsistency), and is exactly why
Architecture #5 introduces a small shared frame parser rather than
hand-rolling a third copy of the same split-on-`\n\n`/`data:`-line logic
`client.ts` and `app.js` each already have their own copy of.

Response frames, using `res.writeHead(200, {"content-type":
"text/event-stream", "cache-control": "no-cache"})` then writing each as
its own `data: <json>\n\n`:

1. One role-announcement chunk first:
   `{"id":..., "object":"chat.completion.chunk", "created":..., "model":..., "choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`
2. One chunk per token piece parsed from the node's stream:
   `{..., "choices":[{"index":0,"delta":{"content":"<piece>"},"finish_reason":null}]}`
3. On the node's `event: usage` frame: one final chunk with the real
   `finish_reason` and an empty delta:
   `{..., "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
   followed by — **only if the request set `stream_options: {include_usage: true}`**
   (real OpenAI's own opt-in convention, reused directly, same reasoning
   as Architecture #2's `includeUsage` field) — one more chunk with an
   **empty `choices` array** and a top-level `usage` object:
   `{..., "choices":[], "usage": {"prompt_tokens":12,"completion_tokens":40,"total_tokens":52}}`.
4. Terminated by a literal `data: [DONE]\n\n`, written by this handler
   itself (not `HttpServer`'s automatic mechanism — this is the
   coordinator's own outbound response now, a plain Node `ServerResponse`,
   not a `ResponseWriter`).

On the node's `event: error` frame: if no chunks have been written yet,
respond with a clean OpenAI-shaped error JSON (see below) instead of
committing to a stream — mirroring `/generate`'s own already-established
"nothing sent yet → real error status" principle from Phase D's
`ResponseWriter::writeError()`. If chunks were already written, the
stream is already committed; end it (matching `/generate`'s own
already-reviewed `res.headersSent` two-way branch, `server.ts:551-556`)
without a fabricated success `[DONE]`.

**Errors, in OpenAI's own envelope shape** (`{"error": {"message": string,
"type": string, "code": string | null}}`), reusing this coordinator's
existing status-code decisions (400 for validation/unsafe, 503 for no
active node, 502 for an unreachable/malformed node) rather than
reinventing them:

```json
{ "error": { "message": "The model 'nonexistent-model' does not exist.", "type": "invalid_request_error", "code": "model_not_found" } }
```

A classifier-blocked prompt (the same fail-closed `classify()` call
`/generate` already makes, on the same flattened prompt string) returns
`400` with `type: "invalid_request_error"` and the matched categories
folded into the human-readable `message` string (e.g. `"Prompt blocked by
safety filter (categories: violence_and_weapons)."`) rather than inventing
new top-level fields outside OpenAI's fixed `{error: {message, type,
code}}` envelope — a real OpenAI-compatible client has nowhere else to
read `safe`/`categories` from, and stuffing them into `message` keeps the
information visible to a human or a log without breaking client-side
schema expectations.

### 5. Shared SSE frame parser (`coordinator/src/sse_frames.ts`, new file)

`client.ts`'s `generateStream()` and `app.js`'s `sendChatMessage()` each
independently implement the same buffer/split-on-`\n\n`/extract-`data:`-lines
logic (confirmed by reading both fresh) — `app.js` genuinely cannot share
code (no ES modules), but the new `/v1/chat/completions` handler runs in
the *same* coordinator process as `client.ts` and has no such constraint.
Rather than hand-rolling a **third** copy of this parsing for the new
handler's own consumption of the node's SSE stream, extract one small,
independently-testable async generator:

```typescript
export interface SseFrame {
  event?: string;      // e.g. "error", "usage" -- absent for a plain data: frame
  data: string;         // multi-line data: content, joined by "\n", per the SSE spec's own convention
}

// Reads Server-Sent Events frames from `reader`, yielding one SseFrame per
// frame, in order, as they arrive -- does not buffer the whole stream
// first. Recognizes a data: payload of exactly "[DONE]" as the stream's
// own terminal sentinel: the generator returns (without yielding it) the
// moment it sees one, exactly like SwarmClient.generateStream() does.
export async function* readSseFrames(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<SseFrame> {
  // body mirrors client.ts's existing generateStream() loop: TextDecoder,
  // buffer, split on "\n\n", per-frame event:/data: line extraction,
  // multi-line data: reconstruction.
}
```

`client.ts`'s already-shipped, already-reviewed `generateStream()` is
**not** refactored to use this — it works, it's tested, and touching
already-merged Phase D code for a pure refactor is out of scope for this
plan (YAGNI; if a future plan wants to de-duplicate, that's its own
freshly-scoped task, not bolted onto this one).

### 6. Coordinator `GET /v1/models` (`coordinator/src/server.ts`)

Routed as `parts[0] === "v1" && parts[1] === "models"` (2 segments),
`GET`. Requires the bearer token (not public — this is live catalog data,
same posture as the existing `GET /catalog`). Reuses
`catalog.availability(activeNodeCount)` (`catalog.ts` needs zero changes)
— the exact same call `GET /catalog` already makes — reshaped, dropping
the `available`/`minActiveNodes` fields OpenAI's own schema has no place
for:

```json
{
  "object": "list",
  "data": [
    { "id": "tinyllama-1.1b", "object": "model", "created": 0, "owned_by": "swarm-llm" }
  ]
}
```

Lists **every** catalog entry regardless of current availability
(mirroring `GET /catalog`'s own existing behavior of never filtering out
under-capacity models) — a model that exists but currently has zero
serving nodes still gets the same `503` from `/v1/chat/completions` that
`/generate` already gives for the identical situation; that is consistent
with how OpenAI's own `/v1/models` never reflects real-time capacity
either. `created` is a fixed placeholder (`0`) since `catalog.ts` has no
per-model creation timestamp — real clients only use this field for
display/sorting, never for correctness, so a constant is sufficient and
this is disclosed in README, not silently invented as if it meant
something.

### 7. `GET /openapi.json`

Both new routes documented in `coordinator/src/openapi.ts`, matching the
existing hand-written-document convention (this doc already needed
correcting twice before — a stale "first-match" claim in Security
Hardening Phase 4, a stale "no streaming" claim during Phase D's own
whole-branch review — so get it right the first time here: real request/
response schemas for both the streaming and non-streaming
`/v1/chat/completions` shapes, and `/v1/models`).

## Rejected Approaches

- **Raw byte passthrough for `/v1/chat/completions`'s streaming response**,
  mirroring `/generate`'s existing design. Rejected: the wire *shapes*
  genuinely differ (internal raw-token-text frames vs. OpenAI's
  JSON-wrapped chunk envelopes) — passthrough only works when both hops
  speak the identical dialect, which was true for `/generate`↔`/complete`
  by deliberate design (Phase D's own Rejected Approaches) but is not true
  here by construction, since translating the protocol is the entire
  point of this endpoint.
- **An unconditional `event: usage` frame on every streaming `/complete`
  call**, instead of gating it behind a new `includeUsage` request field.
  Rejected: proven (by tracing the exact current parsing logic in both
  `client.ts` and `app.js`) to silently corrupt both of Phase D's
  already-shipped streaming consumers, which have no way to recognize an
  `event: usage` frame and would misread its `data:` line as literal
  generated text. The opt-in field keeps every existing caller's wire
  format byte-for-byte unchanged — the same "unchanged default behavior"
  principle every plan in this project's history has held to.
- **Changing `complete()`'s or `completeStreaming()`'s existing
  signatures** (e.g. returning a struct instead of `void`/`std::string`)
  instead of adding optional out-parameters. Rejected: would force changes
  to `swarm-cli`'s `main.cpp` and every existing test in
  `inference_engine_test.cpp`, `http_server_test.cpp`, and
  `node_agent_test.cpp` for zero behavioral benefit to those callers.
  Default-`nullptr` out-parameters are a strictly additive change with
  zero blast radius on already-shipped code.
- **Refactoring `client.ts`'s `generateStream()` to use the new shared SSE
  parser** (Architecture #5). Rejected for this plan: it already works,
  is already tested and whole-branch-reviewed, and refactoring
  already-merged code for pure de-duplication is scope creep here — the
  new parser exists for the new consumer, not to retrofit the old one.
- **Sharing `buildPromptFromMessages()` with `app.js`'s
  `buildChatPrompt()`.** Rejected for the same reason Phase D's Task 5
  already rejected it: `app.js` has zero ES module imports and cannot
  import from any coordinator-side TS file. Not revisited here.

## Open Questions

- **Exact wording of OpenAI's error-envelope `type`/`code` values** for
  each of this coordinator's existing failure modes (unsafe prompt, no
  active node, node unreachable) is not pinned down precisely by this doc
  — implementation-time detail for the plan, informed by what real
  OpenAI-compatible client libraries actually branch on (most only check
  HTTP status and `error.message`, not `error.code`), not re-derived here.
- **Whether `/v1/chat/completions` should also record reputation
  agree/disagree automatically** based on generation success/failure is
  explicitly out of scope — `/generate` doesn't do this either today (a
  disclosed, pre-existing gap named in `CLAUDE.md`'s Security Hardening
  section), and adding automatic reputation feedback is its own
  freshly-scoped initiative, not something to bolt onto this plan.

## Testing Considerations

- `core/tests/inference_engine_test.cpp`: new tests for
  `completeStreaming()`'s three new out-parameters — real prompt-token
  count against a known short prompt, real completion-token count against
  a bounded `n_predict`, `reached_token_limit` true when the cap is hit
  and false when EOG fires first (both real, live generations, not
  mocked). Existing tests need zero changes (all pass `nullptr` implicitly
  via the new defaults).
- `core/tests/http_server_test.cpp`: new tests for
  `ResponseWriter::writeUsage()` — the terminal-state no-op guards (mirror
  the existing `writeChunk()`/`writeError()`/`writeDone()` coverage
  established during Phase D's own hardening fix round), and that it
  produces the exact `event: usage\ndata: {...}\n\n` wire bytes.
- `core/tests/node_agent_test.cpp`: real end-to-end `/complete` calls
  (streaming and non-streaming) against a live model, asserting real
  non-zero `prompt_tokens`/`completion_tokens` and the correct
  `finish_reason` for both a short bounded generation (expect `"length"`)
  and a prompt that reliably reaches EOG quickly (expect `"stop"`); a
  streaming call with `includeUsage: false` (the default) must produce
  byte-for-byte the same frames Phase D's own tests already pin down — a
  regression test that this plan does not silently change `/complete`'s
  existing streaming wire format for existing callers.
- `coordinator/tests/chat_prompt.test.ts` (new): `buildPromptFromMessages()`
  against a `system`+`user`+`assistant` mix, confirming `system` renders
  as `"System:"` and does not collapse into `"Assistant:"` the way the
  dashboard's own copy does.
- `coordinator/tests/sse_frames.test.ts` (new): `readSseFrames()` against
  synthetic multi-frame, multi-line, `event:`-carrying, and
  `[DONE]`-terminated streams — the same coverage shape Phase D's Task 5
  already established for `client.ts`'s equivalent logic, applied to the
  new shared parser.
- `coordinator/tests/server.test.ts`: real HTTP tests (this file's
  established `startTestServer`/`authFetch`/stub-node-agent pattern, not
  mocks) for `/v1/chat/completions` (non-streaming success with real
  usage numbers relayed through; streaming success with real incremental
  chunk delivery, verified the same way Phase D's own "not buffered until
  the end" test proved incremental delivery; the classify-blocks-before-
  node-contact case; the unreachable-node 502 case; a `stream_options:
  {include_usage: true}` request producing the extra trailing usage-only
  chunk; a request *without* it not producing that chunk) and
  `/v1/models` (real catalog reshaping, auth-required).
- **Live-adversarial-probing whole-branch review** (per this project's
  established, consistently bug-finding practice for coordinator/HTTP
  changes): a real coordinator + real `swarm-node-agent` + real GGUF
  model, hit with real `curl`/`fetch` requests shaped exactly like a real
  OpenAI client would send them (including one genuinely produced by
  pointing a real OpenAI-client library's `baseURL` at this coordinator,
  if practical in this environment) — confirming the response is not just
  schema-shaped-correctly but actually consumable by unmodified
  OpenAI-client code, since that consumability is this whole plan's actual
  point.
