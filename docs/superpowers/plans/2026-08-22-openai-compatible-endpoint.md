# OpenAI-Compatible Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /v1/chat/completions` and `GET /v1/models` to the coordinator, giving real OpenAI-API-compatible clients (`deepseek-harness`, Open WebUI, LangChain, etc.) a drop-in model provider backed by this swarm, with real token counts and real streaming.

**Architecture:** `InferenceEngine::completeStreaming()` gains three optional out-parameters (prompt/completion token counts, whether the token cap was hit) via a purely additive signature change. `swarm-node-agent`'s `POST /complete` surfaces these counts unconditionally for non-streaming responses and behind a new opt-in `includeUsage` request field for streaming (an unconditional new SSE event type would silently corrupt the two already-shipped Phase D consumers, which don't recognize it). The coordinator's new handlers reuse the existing classify → reputation-rank → select-node → forward pipeline `/generate` already has, translate `messages[]` into this project's existing plain-text transcript convention, and — for streaming — parse and re-emit OpenAI-shaped chunks rather than doing `/generate`'s raw passthrough, since the wire shapes genuinely differ.

**Tech Stack:** C++17 (`core/`, CMake+Ninja, GoogleTest via ctest) + Node.js 22.6+ native TypeScript (`coordinator/`, zero dependencies, `node:test`).

## Global Constraints

- **Never add a `Co-Authored-By: Claude` trailer to any commit.** State this in every dispatch — it does not carry over automatically.
- C++: build via `cmake -G Ninja -S . -B build && cmake --build build`. Run tests via `cd build && ctest`, or the built binary directly. All C++ tests live in ONE binary (`inference_engine_test`, per `core/tests/CMakeLists.txt`) built from `inference_engine_test.cpp`, `speculative_test.cpp`, `http_server_test.cpp`, `json_utils_test.cpp`, and `node_agent_test.cpp` together — adding tests to any of these existing files needs no `CMakeLists.txt` change.
- Coordinator: zero npm dependencies. Only `node:http`, `node:test`, `node:assert/strict`, `node:crypto`, native `fetch`, `AbortSignal.timeout`, etc. Run via `cd coordinator && npm test`.
- Windows: MSYS2 UCRT64 toolchain; ccache is wired up (`CCACHE_DIR=/c/Users/User/.ccache`) — reuse it, don't cold-rebuild. Environment prelude for every C++ build/test command: `export PATH="/c/msys64/ucrt64/bin:$PATH"; export CCACHE_DIR=/c/Users/User/.ccache`.
- **Every existing behavior this plan touches must remain byte-for-byte unchanged for existing callers**: `complete()`'s signature/behavior, `/complete`'s non-streaming response's existing `text` field and its streaming response's existing wire format when `includeUsage` is absent/false, `/generate`'s entire behavior (untouched by this plan), `SwarmClient`/the dashboard (untouched by this plan). Every existing test in `core/tests/` and `coordinator/tests/` must keep passing unmodified.
- `finish_reason` uses exactly two values throughout this plan: `"stop"` (the model's own end-of-generation token fired) or `"length"` (the token cap was reached first) — OpenAI's own vocabulary, reused directly, not translated through an intermediate representation.

---

### Task 1: `InferenceEngine::completeStreaming()` gains three optional out-parameters

**Files:**
- Modify: `core/include/swarm/inference_engine.h`
- Modify: `core/src/inference_engine.cpp`
- Test: `core/tests/inference_engine_test.cpp`

**Interfaces:**
- Produces: `void InferenceEngine::completeStreaming(const std::string& prompt, int n_predict, const std::function<bool(const std::string&)>& onToken, int* out_prompt_tokens = nullptr, int* out_completion_tokens = nullptr, bool* out_reached_token_limit = nullptr)`. Task 2 depends on exactly this name, signature, and parameter order.
- `complete()`'s existing signature and behavior are unchanged (it becomes, and stays, a thin wrapper that passes none of the three new arguments).

- [ ] **Step 1: Write the failing tests**

Append these tests to the end of `core/tests/inference_engine_test.cpp` (the file already defines `test_model_path()` and includes everything needed — no new includes required):

```cpp
TEST(InferenceEngine, CompleteStreamingReportsRealPromptTokenCount) {
    swarm::InferenceEngine engine(test_model_path());
    int promptTokens = 0;
    engine.completeStreaming("The capital of France is", 5, [](const std::string&) { return true; },
                              &promptTokens, nullptr, nullptr);
    EXPECT_GT(promptTokens, 0);
    // A short handful-of-words prompt tokenizes to more than 1 token (BOS +
    // subwords) but nowhere near, say, 50 -- a loose sanity bound, not an
    // exact hardcoded tokenizer-internal count (which would be brittle
    // across model files).
    EXPECT_LT(promptTokens, 50);
}

TEST(InferenceEngine, CompleteStreamingReportsSameCompletionTokenCountAsCallbackInvocations) {
    swarm::InferenceEngine engine(test_model_path());
    int callbackCount = 0;
    int completionTokens = -1;
    engine.completeStreaming("The capital of France is", 5, [&callbackCount](const std::string&) {
        callbackCount += 1;
        return true;
    }, nullptr, &completionTokens, nullptr);
    EXPECT_EQ(completionTokens, callbackCount);
}

TEST(InferenceEngine, CompleteStreamingReachedTokenLimitMatchesCompletionTokensReachingNPredict) {
    swarm::InferenceEngine engine(test_model_path());
    const int n_predict = 3;
    bool reachedLimit = false;
    int completionTokens = -1;
    // Checks the CONTRACT (reachedLimit is true exactly when completionTokens
    // reached n_predict), not a specific model behavior -- this holds
    // regardless of whether this particular prompt/model combination
    // actually hits the cap or emits its own end-of-generation token first.
    engine.completeStreaming("Once upon a time, in a kingdom far away, there lived a dragon named", n_predict,
                              [](const std::string&) { return true; }, nullptr, &completionTokens, &reachedLimit);
    EXPECT_EQ(reachedLimit, completionTokens >= n_predict);
}

TEST(InferenceEngine, CompleteStreamingReachedTokenLimitIsFalseWhenGenerationStopsBeforeNPredict) {
    swarm::InferenceEngine engine(test_model_path());
    bool reachedLimit = true;  // pre-set to the wrong value, so a false assertion below proves it was actually written
    int completionTokens = -1;
    // onToken returns false on its very first call, forcing an early stop
    // (unless the model's own end-of-generation token fires even earlier,
    // in which case onToken is never called at all) -- either way,
    // completionTokens must be 0 (the break in both cases happens BEFORE
    // n_generated is incremented) and reachedLimit must be false, since
    // n_predict=400 was never reached.
    engine.completeStreaming("Once upon a time, in a kingdom far away, there lived a dragon named", 400,
                              [](const std::string&) { return false; },
                              nullptr, &completionTokens, &reachedLimit);
    EXPECT_EQ(completionTokens, 0);
    EXPECT_FALSE(reachedLimit);
}
```

- [ ] **Step 2: Confirm the tests fail**

Run:
```
export PATH="/c/msys64/ucrt64/bin:$PATH"; export CCACHE_DIR=/c/Users/User/.ccache
cmake --build build --target inference_engine_test
```
Expected: FAIL — 4 compile errors, `no matching function for call to 'completeStreaming'` (the current signature only takes 3 arguments).

- [ ] **Step 3: Add the header declaration**

In `core/include/swarm/inference_engine.h`, find:

```cpp
    // Calls onToken(piece) once per generated token's text, in order, as
    // each is produced -- identical tokenization, sampling, batching, and
    // end-of-generation detection as complete() (which is now implemented
    // as a thin wrapper around this). onToken returning false requests
    // early stop, checked after each token (same effect as reaching
    // n_predict or hitting the model's own end-of-generation token).
    // Throws exactly what complete() would: failed tokenization, prompt
    // too long for the context's batch size, a decode failure, or a
    // token-to-text conversion failure -- before any callback has fired
    // for a pre-generation failure, or after the last successful callback
    // for a mid-generation one.
    void completeStreaming(const std::string& prompt, int n_predict,
                            const std::function<bool(const std::string&)>& onToken);
```

Replace with:

```cpp
    // Calls onToken(piece) once per generated token's text, in order, as
    // each is produced -- identical tokenization, sampling, batching, and
    // end-of-generation detection as complete() (which is now implemented
    // as a thin wrapper around this). onToken returning false requests
    // early stop, checked after each token (same effect as reaching
    // n_predict or hitting the model's own end-of-generation token).
    // Throws exactly what complete() would: failed tokenization, prompt
    // too long for the context's batch size, a decode failure, or a
    // token-to-text conversion failure -- before any callback has fired
    // for a pre-generation failure, or after the last successful callback
    // for a mid-generation one.
    //
    // The three trailing parameters are optional (default nullptr) and, if
    // non-null, are written once, right before this function returns
    // normally -- never on an exception path, matching the throws-before-
    // any-callback / throws-after-the-last-successful-callback contract
    // above exactly (a caller that gets an exception never sees stale or
    // zero-initialized data presented as real). All three already exist as
    // internal local variables in this function's implementation; exposing
    // them costs nothing:
    //   out_prompt_tokens: the real tokenizer-computed prompt length.
    //   out_completion_tokens: the number of tokens actually generated
    //     (equal to the number of onToken calls that returned true).
    //   out_reached_token_limit: true if and only if generation stopped
    //     because n_predict was reached, as opposed to the model's own
    //     end-of-generation token firing or onToken returning false --
    //     equivalent to comparing *out_completion_tokens against n_predict
    //     after the call, exposed directly so a caller doesn't have to
    //     also request out_completion_tokens just to compute it.
    void completeStreaming(const std::string& prompt, int n_predict,
                            const std::function<bool(const std::string&)>& onToken,
                            int* out_prompt_tokens = nullptr,
                            int* out_completion_tokens = nullptr,
                            bool* out_reached_token_limit = nullptr);
```

- [ ] **Step 4: Update the implementation**

In `core/src/inference_engine.cpp`, find the end of `completeStreaming()`'s existing implementation:

```cpp
void InferenceEngine::completeStreaming(const std::string& prompt, int n_predict,
                                          const std::function<bool(const std::string&)>& onToken) {
```

Replace with:

```cpp
void InferenceEngine::completeStreaming(const std::string& prompt, int n_predict,
                                          const std::function<bool(const std::string&)>& onToken,
                                          int* out_prompt_tokens,
                                          int* out_completion_tokens,
                                          bool* out_reached_token_limit) {
```

(Default arguments are specified only in the header declaration, per standard C++ practice — repeating them in the `.cpp` definition is a compile error.)

Then find the end of the function body:

```cpp
        batch = llama_batch_get_one(&new_token, 1);
        n_generated += 1;
    }
}
```

Replace with:

```cpp
        batch = llama_batch_get_one(&new_token, 1);
        n_generated += 1;
    }

    if (out_prompt_tokens) *out_prompt_tokens = n_prompt_tokens;
    if (out_completion_tokens) *out_completion_tokens = n_generated;
    if (out_reached_token_limit) *out_reached_token_limit = (n_generated >= n_predict);
}
```

`complete()` itself (a few lines below) needs **no changes** — it already calls `completeStreaming(prompt, n_predict, lambda)` with exactly 3 arguments, which still compiles unchanged against the new 6-parameter signature thanks to the three new defaults.

- [ ] **Step 5: Build and run the new + existing tests**

```
cmake --build build
cd build && ctest -R InferenceEngine --output-on-failure
```
Expected: all `InferenceEngine.*` tests pass, including the 4 new ones. Every pre-existing `InferenceEngine.*` test (`ThrowsOnInvalidModelPath`, `GeneratesNonEmptyCompletion`, `RepeatedCompleteCallsAreDeterministic`, `ManyCallsDoNotExhaustContext`, all `CompleteStreaming*` and `SpeculativeDecoding*` tests, etc.) must still pass unmodified — `complete()`'s behavior is untouched.

- [ ] **Step 6: Run the full suite (regression check)**

```
cd build && ctest --output-on-failure
```
Expected: 100% pass. Baseline was 85 tests (per `master`'s current state); expect 89 (85 + 4 new).

- [ ] **Step 7: Commit**

```bash
git add core/include/swarm/inference_engine.h core/src/inference_engine.cpp core/tests/inference_engine_test.cpp
git commit -m "InferenceEngine::completeStreaming() gains optional token-count out-parameters"
```

---

### Task 2: `ResponseWriter::writeUsage()` and `swarm-node-agent`'s `/complete` gains real token counts

**Files:**
- Modify: `core/include/swarm/http_server.h`
- Modify: `core/src/http_server.cpp`
- Modify: `core/src/node_agent_main.cpp`
- Test: `core/tests/http_server_test.cpp`
- Test: `core/tests/node_agent_test.cpp`

**Interfaces:**
- Consumes: Task 1's `completeStreaming(prompt, n_predict, onToken, int*, int*, bool*)`.
- Produces: `void ResponseWriter::writeUsage(int promptTokens, int completionTokens, const std::string& finishReason)`. `/complete`'s non-streaming JSON response gains `prompt_tokens`/`completion_tokens`/`finish_reason` fields unconditionally. `/complete`'s request body gains an optional `includeUsage` boolean (default false); when `stream: true` and `includeUsage: true`, the streaming response gains one `event: usage\ndata: {...}\n\n` frame after the last token frame and before the automatic `[DONE]`. Task 4 depends on this exact `includeUsage` field name and the `event: usage` frame's exact JSON shape (`{"prompt_tokens":N,"completion_tokens":M,"finish_reason":"stop"|"length"}`).

- [ ] **Step 1: Write the failing `http_server_test.cpp` tests**

First read `core/tests/http_server_test.cpp` to confirm the highest existing `kTestPort + N` offset (it should be `+22`, per the most recent merged work) so `+23`/`+24`/`+25`/`+26` are free, and to match this file's exact `sendRawRequest`/`startServer`/`HttpServerFixture` style.

Add these four tests near the file's other streaming/terminal-frame tests:

```cpp
TEST_F(HttpServerFixture, StreamingRouteWriteUsageSendsAnEventUsageFrameBeforeDone) {
    swarm::HttpServer server(kTestPort + 23);
    server.routeStreaming("POST", "/stream", [](const swarm::HttpRequest&, swarm::ResponseWriter& writer) {
        writer.writeChunk("hi");
        writer.writeUsage(5, 10, "stop");
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 23, "POST /stream HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");

    EXPECT_NE(response.find("data: hi\n\n"), std::string::npos);
    EXPECT_NE(response.find(R"(event: usage
data: {"prompt_tokens":5,"completion_tokens":10,"finish_reason":"stop"}

)"), std::string::npos);
    // The usage frame must come before the automatically-appended [DONE] --
    // find() returns the position of the FIRST byte of each match, so a
    // smaller offset for "event: usage" than "[DONE]" proves the ordering.
    size_t usagePos = response.find("event: usage");
    size_t donePos = response.find("[DONE]");
    ASSERT_NE(usagePos, std::string::npos);
    ASSERT_NE(donePos, std::string::npos);
    EXPECT_LT(usagePos, donePos);
}

TEST_F(HttpServerFixture, WriteUsageIsANoOpAfterWriteDone) {
    swarm::HttpServer server(kTestPort + 24);
    server.routeStreaming("POST", "/stream", [](const swarm::HttpRequest&, swarm::ResponseWriter& writer) {
        writer.writeChunk("hi");
        writer.writeDone();
        // A handler is not expected to call writeDone() itself, but if one
        // does (or the stream otherwise already ended) and then calls
        // writeUsage(), the usage frame must not reach the wire after the
        // stream already declared itself complete.
        writer.writeUsage(5, 10, "stop");
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 24, "POST /stream HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");

    EXPECT_EQ(response.find("event: usage"), std::string::npos);
}

TEST_F(HttpServerFixture, WriteUsageIsANoOpAfterWriteError) {
    swarm::HttpServer server(kTestPort + 25);
    server.routeStreaming("POST", "/stream", [](const swarm::HttpRequest&, swarm::ResponseWriter& writer) {
        writer.writeChunk("hi");
        writer.writeError("boom");
        writer.writeUsage(5, 10, "stop");
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 25, "POST /stream HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");

    EXPECT_NE(response.find("event: error"), std::string::npos);
    EXPECT_EQ(response.find("event: usage"), std::string::npos);
}

TEST_F(HttpServerFixture, WriteUsageIsANoOpAfterWriteJsonResponse) {
    swarm::HttpServer server(kTestPort + 26);
    server.routeStreaming("POST", "/stream", [](const swarm::HttpRequest&, swarm::ResponseWriter& writer) {
        writer.writeJsonResponse(200, R"({"text":"hi"})");
        writer.writeUsage(5, 10, "stop");
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 26, "POST /stream HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");

    EXPECT_NE(response.find(R"({"text":"hi"})"), std::string::npos);
    EXPECT_EQ(response.find("text/event-stream"), std::string::npos);
    EXPECT_EQ(response.find("event: usage"), std::string::npos);
}
```

- [ ] **Step 2: Confirm the tests fail**

```
export PATH="/c/msys64/ucrt64/bin:$PATH"; export CCACHE_DIR=/c/Users/User/.ccache
cmake --build build --target inference_engine_test
```
Expected: FAIL — `'class swarm::ResponseWriter' has no member named 'writeUsage'` (4 compile errors).

- [ ] **Step 3: Add `writeUsage()` to `ResponseWriter`**

In `core/include/swarm/http_server.h`, find:

```cpp
    // A response that ends in an error frame never also carries a `[DONE]`
    // sentinel: run() calls writeDone() only on the path where the handler
    // returned normally (so "succeeded" and "failed" stay mutually exclusive
    // on the wire for the one call site in this codebase today), and this is
    // now also enforced directly by writeDone()'s own errorSent_ check above,
    // for any future caller of writeError() too.
    void writeError(const std::string& message);
```

Replace with:

```cpp
    // A response that ends in an error frame never also carries a `[DONE]`
    // sentinel: run() calls writeDone() only on the path where the handler
    // returned normally (so "succeeded" and "failed" stay mutually exclusive
    // on the wire for the one call site in this codebase today), and this is
    // now also enforced directly by writeDone()'s own errorSent_ check above,
    // for any future caller of writeError() too.
    void writeError(const std::string& message);

    // Sends one terminal metadata frame:
    // "event: usage\ndata: {"prompt_tokens":N,"completion_tokens":M,"finish_reason":"<finishReason>"}\n\n".
    // Intended to be called at most once, by a handler, after generation
    // completes and before returning -- i.e. before HttpServer::run()'s
    // automatic writeDone() call, so the real wire order is: token chunks,
    // this usage frame, then [DONE]. A silent no-op under the same
    // terminal-state rules as writeChunk()/writeError() -- if a plain JSON
    // response was already sent, or the stream already ended (a [DONE]
    // sentinel or an error frame already went out), this call does nothing.
    // Throws std::runtime_error if the underlying send fails (peer gone).
    void writeUsage(int promptTokens, int completionTokens, const std::string& finishReason);
```

- [ ] **Step 4: Implement `writeUsage()`**

In `core/src/http_server.cpp`, find:

```cpp
void ResponseWriter::writeError(const std::string& message) {
```

(Find the whole `writeError()` function and locate its closing brace `}` — the implementation ends right before `ResponseWriter::writeError`'s closing brace, immediately followed by the next thing in the file, e.g. `HttpServer::HttpServer(...)` or similar.) Insert this new function directly after `writeError()`'s closing brace:

```cpp

void ResponseWriter::writeUsage(int promptTokens, int completionTokens, const std::string& finishReason) {
    ensureSseHeadersSent();
    if (jsonResponseSent_) {
        return;  // a normal response already went out -- see ensureSseHeadersSent's comment
    }
    if (doneSent_ || errorSent_) {
        // The stream already sent its terminal frame ([DONE] or an error) --
        // writing more content now would put it after the stream's own
        // terminator, which no compliant client is still reading for.
        return;
    }
    socket_t s = static_cast<socket_t>(socketHandle_);
    std::string frame = "event: usage\ndata: {\"prompt_tokens\":" + std::to_string(promptTokens) +
                         ",\"completion_tokens\":" + std::to_string(completionTokens) +
                         ",\"finish_reason\":\"" + jsonEscapeString(finishReason) + "\"}\n\n";
    size_t sentTotal = 0;
    while (sentTotal < frame.size()) {
        long long n = sendBytes(s, frame.data() + sentTotal, frame.size() - sentTotal);
        if (n <= 0) {
            throw std::runtime_error("failed to write SSE usage frame: peer gone");
        }
        sentTotal += static_cast<size_t>(n);
    }
}
```

If reading the file shows `writeError()` is not immediately followed by another `ResponseWriter::` method (e.g. `HttpServer::HttpServer` comes next instead), insert `writeUsage()`'s implementation anywhere else within the `ResponseWriter::` method definitions in this file — placement relative to the others does not matter, only that it exists exactly once.

- [ ] **Step 5: Build and run the new + existing HttpServer tests**

```
cmake --build build
cd build && ctest -R HttpServerFixture --output-on-failure
```
Expected: 100% pass, including the 4 new `writeUsage`-related tests.

- [ ] **Step 6: Write the failing `node_agent_test.cpp` tests**

Add these five tests near the file's other `NodeAgentFixture` `/complete` tests:

```cpp
TEST_F(NodeAgentFixture, CompleteEndpointNonStreamingResponseIncludesRealTokenCounts) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("\"prompt_tokens\":"), std::string::npos);
    EXPECT_NE(response.find("\"completion_tokens\":"), std::string::npos);
    // finish_reason must be present and be one of exactly two valid values --
    // the precise boundary logic (reachedLimit vs completionTokens) is
    // already proven at the InferenceEngine unit level (Task 1); this test
    // only proves the JSON WIRING is correct, not the boundary condition
    // itself.
    bool hasStop = response.find("\"finish_reason\":\"stop\"") != std::string::npos;
    bool hasLength = response.find("\"finish_reason\":\"length\"") != std::string::npos;
    EXPECT_TRUE(hasStop || hasLength);
    // This is included REGARDLESS of any includeUsage field -- confirmed by
    // omitting it entirely from this request's body above.
}

TEST_F(NodeAgentFixture, CompleteEndpointStreamingWithIncludeUsageSendsUsageFrameBeforeDone) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8,"stream":true,"includeUsage":true})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    size_t usagePos = response.find("event: usage");
    size_t donePos = response.find("data: [DONE]");
    ASSERT_NE(usagePos, std::string::npos);
    ASSERT_NE(donePos, std::string::npos);
    EXPECT_LT(usagePos, donePos);
    EXPECT_NE(response.find("\"prompt_tokens\":"), std::string::npos);
    EXPECT_NE(response.find("\"completion_tokens\":"), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointStreamingWithoutIncludeUsageOmitsUsageFrame) {
    // Regression test: the existing streaming wire format (Phase D, already
    // shipped and consumed by SwarmClient/the dashboard) must be
    // byte-for-byte unaffected when includeUsage is absent.
    std::string body = R"({"prompt":"The capital of France is","n_predict":8,"stream":true})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_EQ(response.find("event: usage"), std::string::npos);
    size_t done = response.find("data: [DONE]\n\n");
    ASSERT_NE(done, std::string::npos);
    EXPECT_EQ(done + std::strlen("data: [DONE]\n\n"), response.size());
}

TEST_F(NodeAgentFixture, CompleteEndpointStreamingWithIncludeUsageFalseOmitsUsageFrame) {
    // Same regression guarantee as above, but with includeUsage EXPLICITLY
    // false rather than merely absent -- both must behave identically.
    std::string body = R"({"prompt":"The capital of France is","n_predict":8,"stream":true,"includeUsage":false})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_EQ(response.find("event: usage"), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointNonStreamingWithIncludeUsageFieldStillJustReturnsJson) {
    // includeUsage only has meaning for the streaming path -- a non-streaming
    // request that happens to set it must still get the same plain JSON
    // response (with counts, per the first test above), not an SSE stream.
    std::string body = R"({"prompt":"The capital of France is","n_predict":8,"includeUsage":true})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("Content-Type: application/json"), std::string::npos);
    EXPECT_EQ(response.find("text/event-stream"), std::string::npos);
}
```

- [ ] **Step 7: Confirm the new `node_agent_test.cpp` tests fail**

```
cmake --build build --target inference_engine_test
```
Expected: this step compiles cleanly (these tests only use the existing raw-HTTP `sendRawRequest` helper, no new C++ API surface), but running them fails at assertion time — `/complete`'s response has no `prompt_tokens`/`completion_tokens`/`finish_reason` fields yet, and `includeUsage` is not yet a recognized field.

- [ ] **Step 8: Update `/complete`'s handler in `node_agent_main.cpp`**

Find:

```cpp
            bool stream = false;
            swarm::extractJsonBool(req.body, "stream", stream);  // optional -- false if absent/malformed

            if (!stream) {
                try {
                    std::string text = engine->complete(prompt, nPredict);
                    writer.writeJsonResponse(200, R"({"text":")" + swarm::jsonEscapeString(text) + R"("})");
                } catch (const std::exception& e) {
                    writer.writeJsonResponse(500, R"({"error":")" + swarm::jsonEscapeString(e.what()) + R"("})");
                }
                return;
            }
```

Replace with:

```cpp
            bool stream = false;
            swarm::extractJsonBool(req.body, "stream", stream);  // optional -- false if absent/malformed
            bool includeUsage = false;
            swarm::extractJsonBool(req.body, "includeUsage", includeUsage);  // optional -- false if absent/malformed; only meaningful when stream is true

            if (!stream) {
                try {
                    std::string text;
                    int promptTokens = 0;
                    int completionTokens = 0;
                    bool reachedLimit = false;
                    engine->completeStreaming(prompt, nPredict, [&text](const std::string& piece) {
                        text += piece;
                        return true;
                    }, &promptTokens, &completionTokens, &reachedLimit);
                    const std::string finishReason = reachedLimit ? "length" : "stop";
                    writer.writeJsonResponse(200,
                        R"({"text":")" + swarm::jsonEscapeString(text) +
                        R"(","prompt_tokens":)" + std::to_string(promptTokens) +
                        R"(,"completion_tokens":)" + std::to_string(completionTokens) +
                        R"(,"finish_reason":")" + finishReason + R"("})");
                } catch (const std::exception& e) {
                    writer.writeJsonResponse(500, R"({"error":")" + swarm::jsonEscapeString(e.what()) + R"("})");
                }
                return;
            }
```

Then find the streaming branch:

```cpp
            engine->completeStreaming(prompt, nPredict, [&writer](const std::string& piece) {
                writer.writeChunk(piece);
                return true;
            });
        });
```

Replace with:

```cpp
            int promptTokens = 0;
            int completionTokens = 0;
            bool reachedLimit = false;
            engine->completeStreaming(prompt, nPredict, [&writer](const std::string& piece) {
                writer.writeChunk(piece);
                return true;
            }, &promptTokens, &completionTokens, &reachedLimit);
            if (includeUsage) {
                writer.writeUsage(promptTokens, completionTokens, reachedLimit ? "length" : "stop");
            }
        });
```

(The comment block immediately above this streaming call, explaining that an exception here is caught by `HttpServer::run()`'s dispatch loop and turned into a `writeError()` SSE frame, needs no changes — that behavior is unaffected: if `completeStreaming()` throws, `writeUsage()` is never reached, matching the design's "on any exception path the out-parameters/usage frame are never produced" contract.)

- [ ] **Step 9: Run the new + existing tests**

```
cd build && ctest -R NodeAgentFixture --output-on-failure
```
Expected: 100% pass, including the 5 new tests. Every pre-existing `NodeAgentFixture.*` test (`CompleteEndpointReturnsRealGeneratedText`, `CompleteEndpointStreamsRealTokensAsSeparateSseFrames`, `CompleteEndpointWithoutStreamFieldBehavesExactlyAsBefore`, the 400/401 rejection tests) must still pass unmodified — they only assert on fields that still exist unchanged (`text`, the SSE frame shapes), and none of them set `includeUsage`.

- [ ] **Step 10: Run the full suite (regression check)**

```
cd build && ctest --output-on-failure
```
Expected: 100% pass. Baseline after Task 1 was 89; expect 98 (89 + 4 `HttpServerFixture` + 5 `NodeAgentFixture`).

- [ ] **Step 11: Commit**

```bash
git add core/include/swarm/http_server.h core/src/http_server.cpp core/src/node_agent_main.cpp core/tests/http_server_test.cpp core/tests/node_agent_test.cpp
git commit -m "swarm-node-agent's /complete reports real token counts and finish_reason"
```

---

### Task 3: `chat_prompt.ts` and `sse_frames.ts` (new coordinator modules)

**Files:**
- Create: `coordinator/src/chat_prompt.ts`
- Test: `coordinator/tests/chat_prompt.test.ts` (new file)
- Create: `coordinator/src/sse_frames.ts`
- Test: `coordinator/tests/sse_frames.test.ts` (new file)

**Interfaces:**
- Produces: `export interface ChatMessage { role: "system" | "user" | "assistant"; content: string; }` and `export function buildPromptFromMessages(messages: ChatMessage[]): string`.
- Produces: `export interface SseFrame { event?: string; data: string; }` and `export async function* readSseFrames(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<SseFrame>`.
- Task 4 depends on both exact signatures.

- [ ] **Step 1: Write the failing `chat_prompt.test.ts` tests**

Create `coordinator/tests/chat_prompt.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptFromMessages } from "../src/chat_prompt.ts";

test("buildPromptFromMessages renders a single user message with a trailing Assistant: prompt", () => {
  const prompt = buildPromptFromMessages([{ role: "user", content: "What is the capital of France?" }]);
  assert.equal(prompt, "User: What is the capital of France?\nAssistant:");
});

test("buildPromptFromMessages renders a system message with its own System: label, not collapsed into Assistant:", () => {
  const prompt = buildPromptFromMessages([
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hi" },
  ]);
  assert.equal(prompt, "System: You are a helpful assistant.\nUser: Hi\nAssistant:");
});

test("buildPromptFromMessages renders a full system+user+assistant+user transcript in order", () => {
  const prompt = buildPromptFromMessages([
    { role: "system", content: "Be concise." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello!" },
    { role: "user", content: "How are you?" },
  ]);
  assert.equal(prompt, "System: Be concise.\nUser: Hi\nAssistant: Hello!\nUser: How are you?\nAssistant:");
});

test("buildPromptFromMessages on an empty messages array still produces a bare Assistant: prompt", () => {
  const prompt = buildPromptFromMessages([]);
  assert.equal(prompt, "Assistant:");
});
```

- [ ] **Step 2: Confirm it fails**

Run: `cd coordinator && npm test -- --test-name-pattern="buildPromptFromMessages"`
Expected: FAIL — `Cannot find module '../src/chat_prompt.ts'`.

- [ ] **Step 3: Create `chat_prompt.ts`**

```typescript
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Flattens an OpenAI-shaped messages[] array into the same plain-text
// "Role: content" transcript convention the dashboard's buildChatPrompt()
// (coordinator/public/app.js) already uses -- this project has no
// chat-template support anywhere, so reply quality depends entirely on how
// well the selected model continues this transcript. A trailing
// "Assistant:" (no colon-space content) is appended unconditionally,
// prompting the model to continue as the assistant.
//
// Unlike the dashboard's own copy of this idea (which only ever sees
// user/assistant entries in its own chatHistory and collapses any other
// role into "Assistant:"), a "system" message here gets its own "System:"
// label -- a real OpenAI messages[] array can and does contain one.
export function buildPromptFromMessages(messages: ChatMessage[]): string {
  const label = (role: ChatMessage["role"]) =>
    role === "user" ? "User" : role === "system" ? "System" : "Assistant";
  const transcript = messages.map(m => `${label(m.role)}: ${m.content}`).join("\n");
  return (transcript ? transcript + "\n" : "") + "Assistant:";
}
```

- [ ] **Step 4: Run the `chat_prompt.ts` tests**

Run: `cd coordinator && npm test -- --test-name-pattern="buildPromptFromMessages"`
Expected: PASS (all 4 tests green).

- [ ] **Step 5: Write the failing `sse_frames.test.ts` tests**

Create `coordinator/tests/sse_frames.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { readSseFrames } from "../src/sse_frames.ts";

async function streamFromStub(write: (res: import("node:http").ServerResponse) => void): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const server = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    write(res);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected stub server to bind a port");
  }
  const res = await fetch(`http://127.0.0.1:${address.port}/`, { method: "POST" });
  const reader = res.body!.getReader();
  // Server is closed once its response is fully buffered by the fetch --
  // acceptable for a same-process, localhost-only test stub.
  server.close();
  return reader;
}

test("readSseFrames yields one frame per data: line in order", async () => {
  const reader = await streamFromStub(res => {
    res.write("data: Paris\n\n");
    res.write("data:  is\n\n");
    res.write("data: [DONE]\n\n");
  });
  const frames = [];
  for await (const frame of readSseFrames(reader)) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [{ event: undefined, data: "Paris" }, { event: undefined, data: " is" }]);
});

test("readSseFrames reconstructs a multi-line data: payload joined by newlines", async () => {
  const reader = await streamFromStub(res => {
    res.write("data: line one\ndata: line two\n\n");
    res.write("data: [DONE]\n\n");
  });
  const frames = [];
  for await (const frame of readSseFrames(reader)) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [{ event: undefined, data: "line one\nline two" }]);
});

test("readSseFrames reports the event: field on a named event frame", async () => {
  const reader = await streamFromStub(res => {
    res.write("data: partial\n\n");
    res.write('event: error\ndata: {"error":"boom"}\n\n');
  });
  const frames = [];
  for await (const frame of readSseFrames(reader)) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [
    { event: undefined, data: "partial" },
    { event: "error", data: '{"error":"boom"}' },
  ]);
});

test("readSseFrames reports the event: field on a usage frame the same way", async () => {
  const reader = await streamFromStub(res => {
    res.write('event: usage\ndata: {"prompt_tokens":5,"completion_tokens":10,"finish_reason":"stop"}\n\n');
    res.write("data: [DONE]\n\n");
  });
  const frames = [];
  for await (const frame of readSseFrames(reader)) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [
    { event: "usage", data: '{"prompt_tokens":5,"completion_tokens":10,"finish_reason":"stop"}' },
  ]);
});

test("readSseFrames stops at [DONE] without yielding it, even if more bytes somehow follow", async () => {
  const reader = await streamFromStub(res => {
    res.write("data: hi\n\n");
    res.write("data: [DONE]\n\n");
  });
  const frames = [];
  for await (const frame of readSseFrames(reader)) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [{ event: undefined, data: "hi" }]);
});

test("readSseFrames on a stream that yields nothing but [DONE] produces zero frames", async () => {
  const reader = await streamFromStub(res => {
    res.write("data: [DONE]\n\n");
  });
  const frames = [];
  for await (const frame of readSseFrames(reader)) {
    frames.push(frame);
  }
  assert.deepEqual(frames, []);
});
```

- [ ] **Step 6: Confirm it fails**

Run: `cd coordinator && npm test -- --test-name-pattern="readSseFrames"`
Expected: FAIL — `Cannot find module '../src/sse_frames.ts'`.

- [ ] **Step 7: Create `sse_frames.ts`**

```typescript
export interface SseFrame {
  event?: string;
  data: string;
}

// Reads Server-Sent Events frames from `reader`, yielding one SseFrame per
// frame, in order, as they arrive -- does not buffer the whole stream
// first. Mirrors the parsing logic SwarmClient.generateStream()
// (coordinator/src/client.ts) already has, extracted here as a small,
// independently-testable, reusable piece for THIS process's own internal
// consumption of a node agent's SSE stream (a genuinely different use case
// from client.ts, which is the outward-facing SDK other processes use to
// talk to this coordinator -- see this plan's design doc for why they are
// not unified).
//
// Recognizes a data: payload of exactly "[DONE]" as the stream's own
// terminal sentinel: the generator returns (without yielding it) the
// moment it sees one. A frame with an "event: <name>" line reports that
// name via SseFrame.event; a plain data-only frame leaves it undefined. A
// multi-line data: payload (multiple consecutive "data: " lines in one
// frame, per the SSE spec's own multi-line convention) is joined with "\n"
// into SseFrame.data.
export async function* readSseFrames(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const lines = frame.split("\n");
      const eventLine = lines.find(line => line.startsWith("event: "));
      const event = eventLine ? eventLine.slice("event: ".length) : undefined;
      const dataLines = lines.filter(line => line.startsWith("data: "));
      if (dataLines.length === 0) {
        continue;
      }
      const data = dataLines.map(line => line.slice("data: ".length)).join("\n");
      if (data === "[DONE]") {
        return;
      }
      yield { event, data };
    }
  }
}
```

- [ ] **Step 8: Run the `sse_frames.ts` tests**

Run: `cd coordinator && npm test -- --test-name-pattern="readSseFrames"`
Expected: PASS (all 6 tests green).

- [ ] **Step 9: Run the full coordinator suite (regression check)**

Run: `cd coordinator && npm test`
Expected: PASS, all tests -- these are two new, self-contained modules with no existing call sites yet (Task 4 wires them in), so nothing else can regress.

- [ ] **Step 10: Commit**

```bash
git add coordinator/src/chat_prompt.ts coordinator/tests/chat_prompt.test.ts coordinator/src/sse_frames.ts coordinator/tests/sse_frames.test.ts
git commit -m "Add buildPromptFromMessages() and readSseFrames(), the two small modules /v1/chat/completions needs"
```

---

### Task 4: `POST /v1/chat/completions`, `GET /v1/models`, and `openapi.json`

**Files:**
- Modify: `coordinator/src/server.ts`
- Modify: `coordinator/src/openapi.ts`
- Test: `coordinator/tests/server.test.ts`

**Interfaces:**
- Consumes: Task 2's `/complete` `includeUsage` field and its non-streaming `prompt_tokens`/`completion_tokens`/`finish_reason` fields; Task 3's `buildPromptFromMessages()` and `readSseFrames()`.
- Produces: nothing consumed by a later task -- this is the last task in this plan.

- [ ] **Step 1: Write the failing `server.test.ts` tests**

First read `coordinator/tests/server.test.ts`'s existing `startTestServer`, `authFetch`, `startStubNodeAgent`, and `startStreamingStubNodeAgent` helpers (defined near the file's `/generate` tests) to confirm their exact current signatures before writing new tests against them -- this repo's plans are grounded fresh each time, not from memory, since prior fix rounds change signatures.

Add these tests, in a new block after the existing `/generate` tests and before the static-file tests:

```typescript
test("POST /v1/chat/completions returns a real OpenAI-shaped response with real usage numbers", async () => {
  const stub = await startStubNodeAgent(() => ({
    status: 200,
    body: { text: "Paris.", prompt_tokens: 12, completion_tokens: 3, finish_reason: "stop" },
  }));
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "tinyllama-1.1b",
        messages: [{ role: "user", content: "What is the capital of France?" }],
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "tinyllama-1.1b");
    assert.equal(typeof body.id, "string");
    assert.ok(body.id.startsWith("chatcmpl-"));
    assert.equal(typeof body.created, "number");
    assert.equal(body.choices.length, 1);
    assert.equal(body.choices[0].index, 0);
    assert.deepEqual(body.choices[0].message, { role: "assistant", content: "Paris." });
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.deepEqual(body.usage, { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
  } finally {
    server.close();
    stub.server.close();
  }
});

test("POST /v1/chat/completions flattens a system+user transcript before forwarding to the node", async () => {
  let capturedPrompt = "";
  const stub = await startStubNodeAgent((body) => {
    capturedPrompt = (body as { prompt: string }).prompt;
    return { status: 200, body: { text: "Hello!", prompt_tokens: 5, completion_tokens: 2, finish_reason: "stop" } };
  });
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    await authFetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "tinyllama-1.1b",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Hi" },
        ],
      }),
    });

    assert.equal(capturedPrompt, "System: Be concise.\nUser: Hi\nAssistant:");
  } finally {
    server.close();
    stub.server.close();
  }
});

test("POST /v1/chat/completions returns 400 in OpenAI's error envelope for an unknown model", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "nonexistent-model", messages: [{ role: "user", content: "hi" }] }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.type, "invalid_request_error");
    assert.equal(typeof body.error.message, "string");
  } finally {
    server.close();
  }
});

test("POST /v1/chat/completions classifies before contacting any node and reports the block in error.message", async () => {
  const classifier = new KeywordSafetyClassifier([{ category: "test", pattern: /blocked/i }]);
  const { server, baseUrl } = await startTestServer(undefined, undefined, classifier);
  try {
    const res = await authFetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "tinyllama-1.1b", messages: [{ role: "user", content: "this is blocked" }] }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.type, "invalid_request_error");
    assert.ok(body.error.message.includes("test"));
  } finally {
    server.close();
  }
});

test("POST /v1/chat/completions returns 503 in OpenAI's error envelope when no node serves the model", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await authFetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "tinyllama-1.1b", messages: [{ role: "user", content: "hi" }] }),
    });

    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.type, "invalid_request_error");
  } finally {
    server.close();
  }
});

test("POST /v1/chat/completions with stream:true relays real incremental OpenAI-shaped chunks ending in [DONE]", async () => {
  const stub = await startStreamingStubNodeAgent(["Paris", " is", " nice"]);
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "tinyllama-1.1b",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    const dataLines = text.split("\n\n").filter(f => f.startsWith("data: ")).map(f => f.slice("data: ".length));
    assert.equal(dataLines[dataLines.length - 1], "[DONE]");
    const chunks = dataLines.slice(0, -1).map(line => JSON.parse(line));
    assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant" });
    assert.equal(chunks[0].object, "chat.completion.chunk");
    const contentPieces = chunks.slice(1, -1).map(c => c.choices[0].delta.content);
    assert.deepEqual(contentPieces, ["Paris", " is", " nice"]);
    const lastChunk = chunks[chunks.length - 1];
    assert.deepEqual(lastChunk.choices[0].delta, {});
    assert.equal(lastChunk.choices[0].finish_reason, "stop");
  } finally {
    server.close();
    stub.server.close();
  }
});

test("GET /v1/models lists the catalog in OpenAI's list shape and requires auth", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const unauth = await fetch(`${baseUrl}/v1/models`);
    assert.equal(unauth.status, 401);

    const res = await authFetch(`${baseUrl}/v1/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "list");
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length > 0);
    const tinyllama = body.data.find((m: { id: string }) => m.id === "tinyllama-1.1b");
    assert.ok(tinyllama);
    assert.equal(tinyllama.object, "model");
    assert.equal(tinyllama.owned_by, "swarm-llm");
    assert.equal(typeof tinyllama.created, "number");
    assert.equal(tinyllama.available, undefined);
    assert.equal(tinyllama.minActiveNodes, undefined);
  } finally {
    server.close();
  }
});
```

If `KeywordSafetyClassifier` or `startStreamingStubNodeAgent` are not already imported/defined earlier in the file at the point these tests are inserted, no action is needed — both are already used by this file's existing `/generate` tests, confirmed by reading the file in Step 1 above.

- [ ] **Step 2: Confirm the tests fail**

Run: `cd coordinator && npm test -- --test-name-pattern="v1/chat/completions|v1/models"`
Expected: FAIL — every request 404s (no `/v1/*` route exists yet).

- [ ] **Step 3: Add imports**

Find:

```typescript
import { timingSafeEqual } from "node:crypto";
```

Replace with:

```typescript
import { timingSafeEqual, randomUUID } from "node:crypto";
```

Find:

```typescript
import { openApiDocument } from "./openapi.ts";
```

Replace with:

```typescript
import { openApiDocument } from "./openapi.ts";
import { buildPromptFromMessages, type ChatMessage } from "./chat_prompt.ts";
import { readSseFrames } from "./sse_frames.ts";
```

- [ ] **Step 4: Add the two new routes**

Find the end of the `/generate` handler (the closing brace of its `if` block, immediately before the static-file routes):

```typescript
        return;
      }

      if (method === "GET" && parts.length === 0) {
        serveStaticFile(res, "index.html", "text/html; charset=utf-8");
        return;
      }
```

Replace with:

```typescript
        return;
      }

      if (method === "GET" && parts[0] === "v1" && parts[1] === "models" && parts.length === 2) {
        const activeNodeCount = await federatedActiveNodeCount(registry, peers, reputation, authToken);
        const data = catalog.availability(activeNodeCount).map(entry => ({
          id: entry.id,
          object: "model" as const,
          created: 0,
          owned_by: "swarm-llm",
        }));
        sendJson(res, 200, { object: "list", data });
        return;
      }

      if (method === "POST" && parts[0] === "v1" && parts[1] === "chat" && parts[2] === "completions" && parts.length === 3) {
        const body = await readJsonBody(req);
        if (typeof body !== "object" || body === null) {
          sendJson(res, 400, { error: { message: "request body must be a JSON object", type: "invalid_request_error", code: null } });
          return;
        }
        const candidate = body as Record<string, unknown>;

        if (typeof candidate.model !== "string" || !catalog.hasModel(candidate.model)) {
          sendJson(res, 400, { error: { message: `The model '${String(candidate.model)}' does not exist.`, type: "invalid_request_error", code: "model_not_found" } });
          return;
        }
        if (!Array.isArray(candidate.messages) || candidate.messages.length === 0) {
          sendJson(res, 400, { error: { message: "messages must be a non-empty array", type: "invalid_request_error", code: null } });
          return;
        }
        const messages: ChatMessage[] = [];
        for (const m of candidate.messages) {
          if (typeof m !== "object" || m === null) {
            sendJson(res, 400, { error: { message: "each message must be an object", type: "invalid_request_error", code: null } });
            return;
          }
          const mc = m as Record<string, unknown>;
          if (mc.role !== "system" && mc.role !== "user" && mc.role !== "assistant") {
            sendJson(res, 400, { error: { message: "each message's role must be one of: system, user, assistant", type: "invalid_request_error", code: null } });
            return;
          }
          if (typeof mc.content !== "string") {
            sendJson(res, 400, { error: { message: "each message's content must be a string", type: "invalid_request_error", code: null } });
            return;
          }
          messages.push({ role: mc.role, content: mc.content });
        }
        let maxTokens = DEFAULT_N_PREDICT;
        if (candidate.max_tokens !== undefined) {
          if (
            typeof candidate.max_tokens !== "number" ||
            !Number.isInteger(candidate.max_tokens) ||
            candidate.max_tokens < 1 ||
            candidate.max_tokens > MAX_N_PREDICT
          ) {
            sendJson(res, 400, { error: { message: `max_tokens must be an integer between 1 and ${MAX_N_PREDICT}`, type: "invalid_request_error", code: null } });
            return;
          }
          maxTokens = candidate.max_tokens;
        }
        const stream = candidate.stream === true;
        const includeUsageInStream =
          stream &&
          typeof candidate.stream_options === "object" &&
          candidate.stream_options !== null &&
          (candidate.stream_options as Record<string, unknown>).include_usage === true;

        const prompt = buildPromptFromMessages(messages);

        try {
          const result = await withTimeout(classifier.classify(prompt), CLASSIFY_TIMEOUT_MS);
          const safe = result?.safe;
          const categories = result?.categories;
          if (typeof safe !== "boolean" || !Array.isArray(categories)) {
            throw new Error("classifier returned a malformed result");
          }
          if (!safe) {
            const categoryList = uniqueCategories(categories);
            sendJson(res, 400, {
              error: {
                message: `Prompt blocked by safety filter (categories: ${categoryList.length > 0 ? categoryList.join(", ") : "unspecified"}).`,
                type: "invalid_request_error",
                code: null,
              },
            });
            return;
          }
        } catch {
          sendJson(res, 400, {
            error: { message: "Prompt blocked: the safety classifier failed or timed out.", type: "invalid_request_error", code: null },
          });
          return;
        }

        const node = selectNode(registry.listActive(reputation), reputation, candidate.model, random);
        if (!node) {
          sendJson(res, 503, {
            error: { message: `No active node currently serves model '${candidate.model}'.`, type: "invalid_request_error", code: null },
          });
          return;
        }

        const chatCompletionId = "chatcmpl-" + randomUUID();
        const createdAt = Math.floor(Date.now() / 1000);

        if (!stream) {
          try {
            const nodeRes = await fetch(`${node.endpoint}/complete`, {
              method: "POST",
              headers: { "content-type": "application/json", "authorization": `Bearer ${authToken}` },
              body: JSON.stringify({ prompt, n_predict: maxTokens }),
              signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
            });
            if (!nodeRes.ok) {
              sendJson(res, 502, { error: { message: `node returned status ${nodeRes.status}`, type: "invalid_request_error", code: null } });
              return;
            }
            const nodeBody = await nodeRes.json();
            if (typeof nodeBody.text !== "string") {
              sendJson(res, 502, { error: { message: "node returned a malformed response", type: "invalid_request_error", code: null } });
              return;
            }
            const promptTokens = typeof nodeBody.prompt_tokens === "number" ? nodeBody.prompt_tokens : 0;
            const completionTokens = typeof nodeBody.completion_tokens === "number" ? nodeBody.completion_tokens : 0;
            const finishReason = nodeBody.finish_reason === "length" ? "length" : "stop";
            sendJson(res, 200, {
              id: chatCompletionId,
              object: "chat.completion",
              created: createdAt,
              model: candidate.model,
              choices: [{ index: 0, message: { role: "assistant", content: nodeBody.text }, finish_reason: finishReason }],
              usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
            });
          } catch (err) {
            console.warn(`failed to forward /v1/chat/completions to node ${node.endpoint}:`, err);
            sendJson(res, 502, { error: { message: "failed to reach the selected node", type: "invalid_request_error", code: null } });
          }
          return;
        }

        try {
          const nodeRes = await fetch(`${node.endpoint}/complete`, {
            method: "POST",
            headers: { "content-type": "application/json", "authorization": `Bearer ${authToken}` },
            body: JSON.stringify({ prompt, n_predict: maxTokens, stream: true, includeUsage: true }),
            signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
          });
          const nodeContentType = (nodeRes.headers.get("content-type") ?? "").toLowerCase();
          if (!nodeRes.ok || !nodeRes.body || !nodeContentType.startsWith("text/event-stream")) {
            sendJson(res, 502, { error: { message: `node returned status ${nodeRes.status}`, type: "invalid_request_error", code: null } });
            return;
          }

          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          const baseChunk = { id: chatCompletionId, object: "chat.completion.chunk", created: createdAt, model: candidate.model };
          res.write(`data: ${JSON.stringify({ ...baseChunk, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);

          let finishReason: "stop" | "length" = "stop";
          let promptTokens = 0;
          let completionTokens = 0;
          const reader = nodeRes.body.getReader();
          for await (const frame of readSseFrames(reader)) {
            if (frame.event === "error") {
              const message = (() => {
                try {
                  return JSON.parse(frame.data).error ?? "generation failed mid-stream";
                } catch {
                  return "generation failed mid-stream";
                }
              })();
              res.write(`event: error\ndata: ${JSON.stringify({ error: { message, type: "invalid_request_error", code: null } })}\n\n`);
              res.end();
              return;
            }
            if (frame.event === "usage") {
              const usage = JSON.parse(frame.data);
              promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
              completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
              finishReason = usage.finish_reason === "length" ? "length" : "stop";
              continue;
            }
            res.write(`data: ${JSON.stringify({ ...baseChunk, choices: [{ index: 0, delta: { content: frame.data }, finish_reason: null }] })}\n\n`);
          }

          res.write(`data: ${JSON.stringify({ ...baseChunk, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
          if (includeUsageInStream) {
            res.write(`data: ${JSON.stringify({ ...baseChunk, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } })}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
        } catch (err) {
          console.warn(`failed to forward streaming /v1/chat/completions to node ${node.endpoint}:`, err);
          if (!res.headersSent) {
            sendJson(res, 502, { error: { message: "failed to reach the selected node", type: "invalid_request_error", code: null } });
          } else {
            res.end();
          }
        }
        return;
      }

      if (method === "GET" && parts.length === 0) {
        serveStaticFile(res, "index.html", "text/html; charset=utf-8");
        return;
      }
```

- [ ] **Step 5: Run the new tests**

Run: `cd coordinator && npm test -- --test-name-pattern="v1/chat/completions|v1/models"`
Expected: PASS (all 7 new tests green).

- [ ] **Step 6: Run the full coordinator suite (regression check)**

Run: `cd coordinator && npm test`
Expected: PASS, all tests -- especially every existing `/generate` test (this task added new routes but touched zero lines of `/generate`'s own handler).

- [ ] **Step 7: Update `openapi.json`**

Read `coordinator/src/openapi.ts` in full first (it has changed since Phase D's own whole-branch review added the `stream` field documentation to `/generate`) to find its exact current `paths` object structure and the `UNAUTHORIZED_RESPONSE` constant it already defines and reuses.

Find the closing of the `paths` object (the line with `  },\n};` that ends the whole `openApiDocument` object, immediately after `/generate`'s closing `},`):

```typescript
    },
  },
};
```

Replace with:

```typescript
    },
    "/v1/models": {
      get: {
        summary: "List the model catalog in OpenAI's /v1/models shape. Requires auth (unlike real OpenAI, this is live swarm-backed data, not a fixed list) -- lists every catalog entry regardless of current per-model node availability, mirroring GET /catalog's own behavior; a currently-unavailable model still returns the same 503 from /v1/chat/completions or /generate that an unavailable model always has.",
        responses: {
          "401": UNAUTHORIZED_RESPONSE,
          "200": {
            description: "The model catalog, OpenAI-shaped",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    object: { type: "string" },
                    data: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          object: { type: "string" },
                          created: { type: "integer" },
                          owned_by: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/chat/completions": {
      post: {
        summary: "OpenAI-compatible chat completions. Classifies the flattened prompt, routes to a reputation-ranked active node serving the requested model, and returns a real generated reply with real token counts (not estimates) -- as one JSON chat.completion object by default, or a real SSE stream of chat.completion.chunk objects when \"stream\": true is set. No chat-template awareness (messages[] is flattened into a plain-text transcript -- see README), no sampling-parameter support (the engine is greedy-only; temperature/top_p/etc. are accepted but silently have no effect), no tool calls, and no n>1.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["model", "messages"],
                properties: {
                  model: { type: "string" },
                  messages: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["role", "content"],
                      properties: {
                        role: { type: "string", enum: ["system", "user", "assistant"] },
                        content: { type: "string" },
                      },
                    },
                  },
                  max_tokens: { type: "integer", minimum: 1, maximum: 512 },
                  stream: { type: "boolean" },
                  stream_options: {
                    type: "object",
                    properties: { include_usage: { type: "boolean" } },
                    description: "Only include_usage is honored; when stream is true and this is true, one extra trailing chunk with an empty choices array and a top-level usage object is sent just before [DONE].",
                  },
                },
              },
            },
          },
        },
        responses: {
          "401": UNAUTHORIZED_RESPONSE,
          "200": {
            description: "A chat.completion object (application/json) or a chat.completion.chunk SSE stream (text/event-stream), depending on \"stream\".",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    object: { type: "string" },
                    created: { type: "integer" },
                    model: { type: "string" },
                    choices: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          index: { type: "integer" },
                          message: { type: "object", properties: { role: { type: "string" }, content: { type: "string" } } },
                          finish_reason: { type: "string" },
                        },
                      },
                    },
                    usage: {
                      type: "object",
                      properties: {
                        prompt_tokens: { type: "integer" },
                        completion_tokens: { type: "integer" },
                        total_tokens: { type: "integer" },
                      },
                    },
                  },
                },
              },
              "text/event-stream": {
                schema: {
                  type: "string",
                  description: "A sequence of \"data: <chat.completion.chunk JSON>\\n\\n\" frames terminated by \"data: [DONE]\\n\\n\", or an \"event: error\\ndata: {\"error\":{...}}\\n\\n\" frame on mid-stream failure.",
                },
              },
            },
          },
          "400": {
            description: "Invalid request, an unknown model, or a prompt classified unsafe -- always OpenAI's {error: {message, type, code}} envelope.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: {
                      type: "object",
                      properties: { message: { type: "string" }, type: { type: "string" }, code: { type: "string", nullable: true } },
                    },
                  },
                },
              },
            },
          },
          "503": {
            description: "No active node currently serves the requested model",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "object" } } } } },
          },
          "502": {
            description: "The selected node was unreachable or returned a malformed response",
            content: { "application/json": { schema: { type: "object", properties: { error: { type: "object" } } } } },
          },
        },
      },
    },
  },
};
```

- [ ] **Step 8: Run the full coordinator suite one more time**

Run: `cd coordinator && npm test`
Expected: PASS, all tests -- including the existing `"every path+method documented in openapi.json resolves to a real route"` test, which now also covers both new routes.

- [ ] **Step 9: Commit**

```bash
git add coordinator/src/server.ts coordinator/src/openapi.ts coordinator/tests/server.test.ts
git commit -m "Add POST /v1/chat/completions and GET /v1/models"
```

---

## What This Plan Does Not Do

Named explicitly, per this project's established scoping convention:

- No sampling parameter support (`temperature`, `top_p`, etc. accepted, silently ignored — the engine is greedy-only).
- No tool/function calling.
- No `n > 1` (always exactly one choice).
- No real chat-template awareness — `messages[]` is flattened into the same plain-text transcript convention the dashboard already uses, not a model-specific chat format.
- No automatic reputation feedback from `/v1/chat/completions`'s own success/failure (matching `/generate`'s existing, already-disclosed gap in this area).
- `SwarmClient`, the dashboard, and `/generate` are completely untouched — this plan is purely additive.
- Updating `README.md`/`CLAUDE.md` for this plan happens after merge, per `ddc-plan-workflow`'s established "After Merge" step, not as one of this plan's own tasks.
