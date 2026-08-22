# Phase D: Token Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real token-by-token streaming, end to end: `InferenceEngine` yields tokens as generated, `swarm-node-agent`'s `/complete` and the coordinator's `/generate` relay them as Server-Sent Events when the caller asks for `stream: true`, and `SwarmClient` plus the dashboard's chat panel consume and render them incrementally. Every existing non-streaming caller and test keeps working unchanged.

**Architecture:** Five tasks in dependency order, each independently testable: (1) `InferenceEngine::completeStreaming()`, a callback-based sibling of the existing `complete()`; (2) `HttpServer` gains a `routeStreaming()`/`ResponseWriter` mechanism that lets one registered route serve either a normal JSON response or an SSE stream, decided per-request by the handler (not by `HttpServer`'s routing, which only matches on method+path); (3) `swarm-node-agent`'s `/complete` moves to this mechanism and honors an optional `stream: true` body field; (4) the coordinator's `/generate` gains the same field and relays the node's SSE bytes straight through; (5) `SwarmClient.generateStream()` and the dashboard's chat panel consume it.

**Tech Stack:** C++17/CMake+Ninja/GoogleTest via ctest for `core/`; Node.js native TypeScript/zero deps/`node:test` for `coordinator/`. No new dependencies anywhere.

## Global Constraints

- **Never add a `Co-Authored-By: Claude` trailer to any commit.** State this in every dispatch — it does not carry over automatically.
- C++: build via `cmake -G Ninja -S . -B build && cmake --build build`. Run tests via `cd build && ctest`, or the built binary directly. All C++ tests live in ONE binary (`inference_engine_test`, per `core/tests/CMakeLists.txt`) built from `inference_engine_test.cpp`, `speculative_test.cpp`, `http_server_test.cpp`, `json_utils_test.cpp`, and `node_agent_test.cpp` together — adding tests to any of these existing files needs no `CMakeLists.txt` change.
- Coordinator: zero npm dependencies. Only `node:http`, `node:test`, `node:assert/strict`, native `fetch`, `AbortSignal.timeout`, etc. Run via `cd coordinator && npm test`.
- Windows: MSYS2 UCRT64 toolchain; ccache is wired up (`CCACHE_DIR=/c/Users/User/.ccache`) — reuse it, don't cold-rebuild.
- `/complete` and `/generate`'s existing non-streaming behavior (no `stream` field, or `stream: false`) must remain byte-for-byte unchanged. Every existing test in `core/tests/` and `coordinator/tests/` must keep passing unmodified.
- **Known, disclosed limitation this plan does not change**: a remote-RPC-sharded node crashing (`GGML_ABORT`) is an uncatchable process-level abort, not a C++ exception — no `try`/`catch` anywhere in this plan can turn it into a clean SSE error frame, because the whole `swarm-node-agent` process terminates before any response of any kind could be sent. This is the exact same pre-existing, already-disclosed limitation named in `CLAUDE.md`'s Phase A section for the non-streaming path; streaming does not fix it, and no task below should claim to.

---

### Task 1: `InferenceEngine::completeStreaming()`

**Files:**
- Modify: `core/include/swarm/inference_engine.h`
- Modify: `core/src/inference_engine.cpp`
- Test: `core/tests/inference_engine_test.cpp`

**Interfaces:**
- Produces: `void InferenceEngine::completeStreaming(const std::string& prompt, int n_predict, const std::function<bool(const std::string&)>& onToken)`. Task 3 depends on exactly this name and signature.
- `complete()`'s existing signature and behavior are unchanged (it becomes a thin wrapper).

- [ ] **Step 1: Write the failing tests**

Append these tests to the end of `core/tests/inference_engine_test.cpp` (the file already defines `test_model_path()` and includes everything needed — no new includes required):

```cpp
TEST(InferenceEngine, CompleteStreamingInvokesCallbackAtLeastOnce) {
    swarm::InferenceEngine engine(test_model_path());
    int call_count = 0;

    engine.completeStreaming("The capital of France is", 8, [&call_count](const std::string&) {
        ++call_count;
        return true;
    });

    EXPECT_GT(call_count, 0);
    EXPECT_LE(call_count, 8);
}

TEST(InferenceEngine, CompleteStreamingConcatenationMatchesComplete) {
    swarm::InferenceEngine engine(test_model_path());
    std::string streamed;

    engine.completeStreaming("The capital of France is", 8, [&streamed](const std::string& piece) {
        streamed += piece;
        return true;
    });
    std::string direct = engine.complete("The capital of France is", 8);

    // Relies on the same per-engine determinism RepeatedCompleteCallsAreDeterministic
    // above already proves (same prompt/n_predict on one engine instance
    // yields identical output) -- reused here rather than re-derived, and
    // avoids loading the model a second time.
    EXPECT_EQ(streamed, direct);
}

TEST(InferenceEngine, CompleteStreamingStopsEarlyWhenCallbackReturnsFalse) {
    swarm::InferenceEngine engine(test_model_path());
    int call_count = 0;

    engine.completeStreaming("The capital of France is", 8, [&call_count](const std::string&) {
        ++call_count;
        return call_count < 2;  // stop after the second token
    });

    EXPECT_EQ(call_count, 2);
}

TEST(InferenceEngine, CompleteStreamingThrowsOnPromptExceedingBatchSizeBeforeAnyCallback) {
    swarm::InferenceEngine engine(test_model_path());
    std::string long_prompt;
    for (int i = 0; i < 3000; ++i) {
        long_prompt += "hello ";
    }
    bool callback_invoked = false;

    EXPECT_THROW(
        engine.completeStreaming(long_prompt, 8, [&callback_invoked](const std::string&) {
            callback_invoked = true;
            return true;
        }),
        std::runtime_error);
    EXPECT_FALSE(callback_invoked);
}

TEST(InferenceEngine, CompleteStillReturnsNonEmptyTextAfterBecomingAWrapper) {
    swarm::InferenceEngine engine(test_model_path());

    std::string result = engine.complete("The capital of France is", 8);

    EXPECT_FALSE(result.empty());
}
```

- [ ] **Step 2: Confirm the tests fail to compile**

Run: `cmake --build build --target inference_engine_test`
Expected: FAIL — compile error, `completeStreaming` is not a member of `InferenceEngine` (the declaration doesn't exist yet).

- [ ] **Step 3: Add the declaration**

In `core/include/swarm/inference_engine.h`, find:

```cpp
#include <cstdint>
#include <string>
#include <vector>
```

Replace with:

```cpp
#include <cstdint>
#include <functional>
#include <string>
#include <vector>
```

Then find:

```cpp
    std::string complete(const std::string& prompt, int n_predict);
```

Replace with:

```cpp
    std::string complete(const std::string& prompt, int n_predict);

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

- [ ] **Step 4: Replace `complete()`'s implementation**

In `core/src/inference_engine.cpp`, find the entire existing function (from its signature through its closing brace):

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

Replace it with:

```cpp
void InferenceEngine::completeStreaming(const std::string& prompt, int n_predict,
                                          const std::function<bool(const std::string&)>& onToken) {
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
    // RAII wrapper: the original complete() called llama_sampler_free at two
    // separate throw sites plus the normal-return path (three manual call
    // sites for one resource). Turning this loop inside-out to invoke a
    // caller-supplied callback per token adds new ways for control flow to
    // leave this function (the callback itself throwing) that a fourth
    // manual free call site would otherwise need to cover. A local RAII
    // guard covers every exit path -- including ones this function's own
    // code never explicitly anticipates -- for free.
    struct SamplerGuard {
        llama_sampler* sampler;
        ~SamplerGuard() { llama_sampler_free(sampler); }
    } guard{sampler};

    llama_batch batch = llama_batch_get_one(
        prompt_tokens.data(), static_cast<int32_t>(prompt_tokens.size()));

    llama_token new_token;
    int n_generated = 0;

    while (n_generated < n_predict) {
        if (llama_decode(ctx_, batch) != 0) {
            throw std::runtime_error("llama_decode failed");
        }

        new_token = llama_sampler_sample(sampler, ctx_, -1);
        if (llama_vocab_is_eog(vocab, new_token)) {
            break;
        }

        char piece[128];
        int n = llama_token_to_piece(vocab, new_token, piece, sizeof(piece), 0, true);
        if (n < 0) {
            throw std::runtime_error("failed to convert token to text");
        }
        if (!onToken(std::string(piece, n))) {
            break;
        }

        batch = llama_batch_get_one(&new_token, 1);
        n_generated += 1;
    }
}

std::string InferenceEngine::complete(const std::string& prompt, int n_predict) {
    std::string result;
    completeStreaming(prompt, n_predict, [&result](const std::string& piece) {
        result.append(piece);
        return true;
    });
    return result;
}
```

- [ ] **Step 5: Build and run the tests**

Run: `cmake --build build --target inference_engine_test && cd build && ctest -R InferenceEngine --output-on-failure`
Expected: PASS — all `InferenceEngine.*` tests, including the 5 new ones and every pre-existing one (`ThrowsOnInvalidModelPath`, `GeneratesNonEmptyCompletion`, `ThrowsOnPromptExceedingBatchSize`, `RepeatedCompleteCallsAreDeterministic`, `ManyCallsDoNotExhaustContext`, etc.) — none of their behavior changed, only how `complete()` is implemented internally.

- [ ] **Step 6: Run the full existing suite to check for regressions**

Run: `cd build && ctest --output-on-failure`
Expected: PASS — including `SplitsAcrossLocalAndRemoteDevice` and every `SpeculativeDecoding`/`NodeAgent` test, none of which touch `complete()`'s internals directly but do call it transitively.

- [ ] **Step 7: Commit**

```bash
git add core/include/swarm/inference_engine.h core/src/inference_engine.cpp core/tests/inference_engine_test.cpp
git commit -m "Add InferenceEngine::completeStreaming(); complete() becomes a thin wrapper"
```

---

### Task 2: `HttpServer` streaming support

**Files:**
- Modify: `core/include/swarm/http_server.h`
- Modify: `core/src/http_server.cpp`
- Test: `core/tests/http_server_test.cpp`

**Interfaces:**
- Consumes: nothing from Task 1 (this task is independent of it; both feed into Task 3).
- Produces: `class ResponseWriter` with `writeJsonResponse(int status, const std::string& body)`, `writeChunk(const std::string& text)`, `writeError(const std::string& message)`; `using StreamingHttpHandler = std::function<void(const HttpRequest&, ResponseWriter&)>`; `HttpServer::routeStreaming(const std::string& method, const std::string& path, StreamingHttpHandler handler)`. Task 3 depends on exactly these names/signatures.

**Design note carried over from this plan's own scoping**: `HttpServer` routes purely on `(method, path)` — a request body field like `stream: true` can't be used to pick between two *different* registered routes at dispatch time, only inspected by whichever single handler routing already selected. So `routeStreaming()` handlers decide, per request, whether to call `writeJsonResponse()` (a normal, complete, non-streaming response — used when the caller didn't ask to stream) or one-or-more `writeChunk()`/`writeError()` calls (an SSE stream). Exactly one of these is ever used per request; `ResponseWriter` enforces that the first call wins.

- [ ] **Step 1: Write the failing tests**

Add this test-client helper to `core/tests/http_server_test.cpp`, directly after the existing `sendRawRequest` function:

```cpp
// Like sendRawRequest, but preserves the boundary between separate recv()
// arrivals instead of collapsing everything into one string -- needed to
// prove tokens/chunks actually arrive incrementally rather than being
// buffered and sent all at once, which read-to-EOF-into-one-string can't
// distinguish.
std::vector<std::string> sendRawRequestCapturingChunks(int port, const std::string& rawRequest) {
#ifdef _WIN32
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);
#endif
    socket_t s = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(static_cast<uint16_t>(port));

    if (connect(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        closeTestSocket(s);
        throw std::runtime_error("test client failed to connect");
    }

    send(s, rawRequest.data(), static_cast<int>(rawRequest.size()), 0);

    std::vector<std::string> chunks;
    char buf[4096];
    for (;;) {
        int n = recv(s, buf, sizeof(buf), 0);
        if (n <= 0) break;
        chunks.emplace_back(buf, static_cast<size_t>(n));
    }
    closeTestSocket(s);
    return chunks;
}
```

Add `#include <vector>` to this file's includes if not already present (check the top of the file first — it already includes `<string>` and `<thread>` but may not include `<vector>` directly).

Then add these tests at the end of the file, before the closing `}  // namespace`:

```cpp
TEST_F(HttpServerFixture, StreamingRouteSendsChunksAsSeparateArrivalsNotOneBufferedBlob) {
    swarm::HttpServer server(kTestPort + 10);
    server.routeStreaming("POST", "/stream", [](const swarm::HttpRequest&, swarm::ResponseWriter& writer) {
        writer.writeChunk("first");
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        writer.writeChunk("second");
    });
    startServer(server);

    std::vector<std::string> chunks = sendRawRequestCapturingChunks(
        kTestPort + 10, "POST /stream HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");

    // The 150ms sleep between writeChunk calls means a client reading in a
    // blocking loop should see at least the headers+"first" frame arrive
    // separately from "second" -- a coalescing/buffering implementation
    // would instead deliver everything in one final read.
    ASSERT_GE(chunks.size(), 2u);
    std::string assembled;
    for (const auto& c : chunks) assembled += c;
    EXPECT_NE(assembled.find("text/event-stream"), std::string::npos);
    EXPECT_NE(assembled.find("data: first\n\n"), std::string::npos);
    EXPECT_NE(assembled.find("data: second\n\n"), std::string::npos);
}

TEST_F(HttpServerFixture, StreamingRouteSplitsAMultiLineChunkIntoMultipleDataLinesInOneFrame) {
    swarm::HttpServer server(kTestPort + 11);
    server.routeStreaming("POST", "/stream", [](const swarm::HttpRequest&, swarm::ResponseWriter& writer) {
        writer.writeChunk("line one\nline two");
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 11, "POST /stream HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");

    // Per the SSE spec's own multi-line convention: multiple "data: " lines
    // for one event, not a single line containing a raw newline (which
    // would look like the frame's own terminator to a spec-compliant parser).
    EXPECT_NE(response.find("data: line one\ndata: line two\n\n"), std::string::npos);
}

TEST_F(HttpServerFixture, StreamingRouteSendsAnErrorFrameWhenTheHandlerThrows) {
    swarm::HttpServer server(kTestPort + 12);
    server.routeStreaming("POST", "/stream", [](const swarm::HttpRequest&, swarm::ResponseWriter& writer) {
        writer.writeChunk("partial");
        throw std::runtime_error("boom");
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 12, "POST /stream HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");

    EXPECT_NE(response.find("data: partial\n\n"), std::string::npos);
    EXPECT_NE(response.find("event: error"), std::string::npos);
    EXPECT_NE(response.find(R"("error":"boom")"), std::string::npos);
}

TEST_F(HttpServerFixture, StreamingRouteHandlerCanWriteANormalNonStreamingResponseInstead) {
    swarm::HttpServer server(kTestPort + 13);
    server.routeStreaming("POST", "/maybe-stream", [](const swarm::HttpRequest&, swarm::ResponseWriter& writer) {
        writer.writeJsonResponse(200, R"({"text":"not streamed"})");
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 13, "POST /maybe-stream HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("Content-Type: application/json"), std::string::npos);
    EXPECT_NE(response.find(R"({"text":"not streamed"})"), std::string::npos);
    EXPECT_EQ(response.find("text/event-stream"), std::string::npos);
}

TEST_F(HttpServerFixture, RegularRoutesStillWorkAlongsideAStreamingRoute) {
    swarm::HttpServer server(kTestPort + 14);
    server.route("GET", "/health", [](const swarm::HttpRequest&) {
        return swarm::HttpResponse{200, R"({"status":"ready"})"};
    });
    server.routeStreaming("POST", "/stream", [](const swarm::HttpRequest&, swarm::ResponseWriter& writer) {
        writer.writeChunk("x");
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 14, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n");

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find(R"({"status":"ready"})"), std::string::npos);
    EXPECT_EQ(response.find("text/event-stream"), std::string::npos);
}
```

- [ ] **Step 2: Confirm the tests fail to compile**

Run: `cmake --build build --target inference_engine_test`
Expected: FAIL — `routeStreaming` is not a member of `HttpServer`, `ResponseWriter` is not declared.

- [ ] **Step 3: Update the header**

Replace the full contents of `core/include/swarm/http_server.h` with:

```cpp
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <tuple>
#include <vector>

namespace swarm {

struct HttpRequest {
    std::string method;
    std::string path;
    std::string body;
    // Header names are lowercased during parsing -- look up with a
    // lowercase key (e.g. headers.find("authorization"), not "Authorization").
    std::map<std::string, std::string> headers;
};

struct HttpResponse {
    int status = 200;
    std::string body;
};

using HttpHandler = std::function<HttpResponse(const HttpRequest&)>;

// Handed to a StreamingHttpHandler. Exactly one of writeJsonResponse() or
// one-or-more calls to writeChunk()/writeError() may be made on a given
// ResponseWriter -- whichever is called first commits this response to
// being either a normal single JSON response or an SSE stream; any further
// call (of either kind) after that is a silent no-op, since a response's
// status line and headers can only be sent once. This lets one
// streaming-registered route serve both a plain, unchanged non-streaming
// response (when a handler determines, after inspecting the request, that
// this particular call shouldn't actually stream) and a real SSE stream,
// from the same registration -- HttpServer's routing is (method, path)
// only, so a request body field can't be used to pick between two
// DIFFERENT registered routes at dispatch time; it can only be inspected
// by the one handler routing already selected.
class ResponseWriter {
public:
    // Sends one complete, non-streaming HTTP response -- status line,
    // Content-Type: application/json, Content-Length, Connection: close,
    // then `body` -- byte-for-byte the same wire format the regular,
    // non-streaming HttpHandler path produces for an equivalent
    // HttpResponse{status, body}.
    void writeJsonResponse(int status, const std::string& body);

    // Sends SSE response headers on the first call to writeChunk() or
    // writeError() on this ResponseWriter (a no-op on later calls), then
    // one `data: <text>\n\n` frame. A `text` containing an embedded '\n'
    // is sent as multiple consecutive `data: ` lines belonging to the same
    // event, per the SSE spec's own multi-line convention -- otherwise the
    // embedded newline would look like the frame's own terminator to a
    // spec-compliant SSE parser. Throws std::runtime_error if the
    // underlying send fails (peer gone).
    void writeChunk(const std::string& text);

    // Sends SSE response headers if not already sent, then one terminal
    // `event: error\ndata: {"error":"<message>"}\n\n` frame -- the defined
    // way to signal "generation failed" after a stream may have already
    // delivered real content, which changing the HTTP status code cannot
    // do once a 200 and its headers are already on the wire. Throws
    // std::runtime_error if the underlying send fails.
    void writeError(const std::string& message);

private:
    friend class HttpServer;
    explicit ResponseWriter(intptr_t socketHandle);
    void ensureSseHeadersSent();

    intptr_t socketHandle_;
    bool sseHeadersSent_ = false;
    bool jsonResponseSent_ = false;
};

using StreamingHttpHandler = std::function<void(const HttpRequest&, ResponseWriter&)>;

// Minimal, blocking, single-connection-at-a-time HTTP/1.1 server. Serves
// only routes registered via route()/routeStreaming() -- exact (method,
// path) string match, no wildcards, no query strings, no path parameters.
// Every non-streaming response is sent with Content-Type: application/json
// and the connection is closed immediately after (no keep-alive); a
// streaming response holds the connection open for the duration of the
// stream, then also closes (not persistent multi-request keep-alive,
// just one long-lived single response). This exists to be one process's
// small, fixed local API surface, not a general-purpose web server --
// routeStreaming()/ResponseWriter is a deliberate, narrow exception to
// that (Phase D: token streaming), not a step toward becoming one; do not
// extend this further without a similarly specific reason.
class HttpServer {
public:
    explicit HttpServer(int port);

    // Registers a handler for an exact (method, path) pair. Must be called
    // before run(). A (method, path) already registered via route() or
    // routeStreaming() cannot be registered again via either -- first
    // registration wins, checked across both tables together.
    void route(const std::string& method, const std::string& path, HttpHandler handler);

    // Registers a handler that decides, per request, whether to respond
    // with one complete response (ResponseWriter::writeJsonResponse) or an
    // SSE stream (writeChunk()/writeError()). Same first-match-wins
    // contract as route(), checked jointly with it.
    void routeStreaming(const std::string& method, const std::string& path, StreamingHttpHandler handler);

    // Binds the port on 127.0.0.1 and blocks forever, accepting one
    // connection at a time and dispatching each request to its matching
    // registered handler (404, empty body, if none matches; 400 with a
    // JSON error body if the request itself is malformed -- e.g. no
    // Content-Length on a request with a body, or the connection closes
    // mid-request). Throws std::runtime_error if the port cannot be bound
    // or listened on. Never returns under normal operation.
    void run();

private:
    int port_;
    std::vector<std::tuple<std::string, std::string, HttpHandler>> routes_;
    std::vector<std::tuple<std::string, std::string, StreamingHttpHandler>> streamingRoutes_;
};

}  // namespace swarm
```

- [ ] **Step 4: Update the implementation**

In `core/src/http_server.cpp`, find:

```cpp
}  // namespace

HttpServer::HttpServer(int port) : port_(port) {}

void HttpServer::route(const std::string& method, const std::string& path, HttpHandler handler) {
    routes_.emplace_back(method, path, std::move(handler));
}

void HttpServer::run() {
```

Replace with:

```cpp
}  // namespace

void ResponseWriter::ensureSseHeadersSent() {
    if (sseHeadersSent_ || jsonResponseSent_) {
        // jsonResponseSent_: a complete response was already sent on this
        // connection -- writing SSE headers now would corrupt the wire by
        // appending a second response after one that already declared its
        // own Content-Length and closed. Silently no-op rather than throw:
        // the only caller of this path (HttpServer::run()'s catch block,
        // if a handler throws after already calling writeJsonResponse) has
        // no safe recovery action available either way.
        return;
    }
    socket_t s = static_cast<socket_t>(socketHandle_);
    static const char kSseHeaders[] =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/event-stream\r\n"
        "Cache-Control: no-cache\r\n"
        "Connection: close\r\n"
        "\r\n";
    size_t len = sizeof(kSseHeaders) - 1;  // exclude the trailing '\0'
    size_t sentTotal = 0;
    while (sentTotal < len) {
        long long n = sendBytes(s, kSseHeaders + sentTotal, len - sentTotal);
        if (n <= 0) {
            throw std::runtime_error("failed to write SSE headers: peer gone");
        }
        sentTotal += static_cast<size_t>(n);
    }
    sseHeadersSent_ = true;
}

ResponseWriter::ResponseWriter(intptr_t socketHandle) : socketHandle_(socketHandle) {}

void ResponseWriter::writeJsonResponse(int status, const std::string& body) {
    if (sseHeadersSent_ || jsonResponseSent_) {
        return;  // already committed to a response -- see ensureSseHeadersSent's comment
    }
    writeResponse(static_cast<socket_t>(socketHandle_), HttpResponse{status, body});
    jsonResponseSent_ = true;
}

void ResponseWriter::writeChunk(const std::string& text) {
    ensureSseHeadersSent();
    if (jsonResponseSent_) {
        return;  // a normal response already went out -- see ensureSseHeadersSent's comment
    }
    socket_t s = static_cast<socket_t>(socketHandle_);
    std::ostringstream out;
    size_t start = 0;
    for (;;) {
        size_t nl = text.find('\n', start);
        std::string line = (nl == std::string::npos) ? text.substr(start) : text.substr(start, nl - start);
        out << "data: " << line << "\n";
        if (nl == std::string::npos) {
            break;
        }
        start = nl + 1;
    }
    out << "\n";
    std::string frame = out.str();
    size_t sentTotal = 0;
    while (sentTotal < frame.size()) {
        long long n = sendBytes(s, frame.data() + sentTotal, frame.size() - sentTotal);
        if (n <= 0) {
            throw std::runtime_error("failed to write SSE chunk: peer gone");
        }
        sentTotal += static_cast<size_t>(n);
    }
}

void ResponseWriter::writeError(const std::string& message) {
    ensureSseHeadersSent();
    if (jsonResponseSent_) {
        return;  // a normal response already went out -- see ensureSseHeadersSent's comment
    }
    socket_t s = static_cast<socket_t>(socketHandle_);
    std::string frame = "event: error\ndata: {\"error\":\"" + jsonEscapeString(message) + "\"}\n\n";
    size_t sentTotal = 0;
    while (sentTotal < frame.size()) {
        long long n = sendBytes(s, frame.data() + sentTotal, frame.size() - sentTotal);
        if (n <= 0) {
            throw std::runtime_error("failed to write SSE error: peer gone");
        }
        sentTotal += static_cast<size_t>(n);
    }
}

HttpServer::HttpServer(int port) : port_(port) {}

void HttpServer::route(const std::string& method, const std::string& path, HttpHandler handler) {
    routes_.emplace_back(method, path, std::move(handler));
}

void HttpServer::routeStreaming(const std::string& method, const std::string& path, StreamingHttpHandler handler) {
    streamingRoutes_.emplace_back(method, path, std::move(handler));
}

void HttpServer::run() {
```

`jsonEscapeString` is used above but currently lives in `swarm::` (declared in `json_utils.h`), not this file. Find this file's include block:

```cpp
#include "swarm/http_server.h"

#include <cctype>
#include <csignal>
#include <cstdint>
#include <map>
#include <sstream>
#include <stdexcept>
#include <utility>
```

Replace with:

```cpp
#include "swarm/http_server.h"
#include "swarm/json_utils.h"

#include <cctype>
#include <csignal>
#include <cstdint>
#include <map>
#include <sstream>
#include <stdexcept>
#include <utility>
```

Now find the dispatch loop inside `run()`:

```cpp
        try {
            std::string head = readUntilHeadersEnd(client);
            std::string bodySoFar;
            ParsedHead parsed = parseHead(head, bodySoFar);
            std::string body = readBody(client, std::move(bodySoFar), parsed.contentLength);

            HttpRequest request{parsed.method, parsed.path, body, parsed.headers};

            HttpResponse response{404, ""};
            for (const auto& routeEntry : routes_) {
                if (std::get<0>(routeEntry) == parsed.method && std::get<1>(routeEntry) == parsed.path) {
                    response = std::get<2>(routeEntry)(request);
                    break;
                }
            }
            writeResponse(client, response);
        } catch (const std::exception&) {
            writeResponse(client, HttpResponse{400, R"({"error":"malformed request"})"});
        }
```

Replace with:

```cpp
        try {
            std::string head = readUntilHeadersEnd(client);
            std::string bodySoFar;
            ParsedHead parsed = parseHead(head, bodySoFar);
            std::string body = readBody(client, std::move(bodySoFar), parsed.contentLength);

            HttpRequest request{parsed.method, parsed.path, body, parsed.headers};

            bool matchedStreaming = false;
            for (const auto& routeEntry : streamingRoutes_) {
                if (std::get<0>(routeEntry) == parsed.method && std::get<1>(routeEntry) == parsed.path) {
                    matchedStreaming = true;
                    ResponseWriter writer(static_cast<intptr_t>(client));
                    try {
                        std::get<2>(routeEntry)(request, writer);
                    } catch (const std::exception& e) {
                        try {
                            writer.writeError(e.what());
                        } catch (const std::exception&) {
                            // peer already gone -- nothing more we can do
                        }
                    }
                    break;
                }
            }

            if (!matchedStreaming) {
                HttpResponse response{404, ""};
                for (const auto& routeEntry : routes_) {
                    if (std::get<0>(routeEntry) == parsed.method && std::get<1>(routeEntry) == parsed.path) {
                        response = std::get<2>(routeEntry)(request);
                        break;
                    }
                }
                writeResponse(client, response);
            }
        } catch (const std::exception&) {
            writeResponse(client, HttpResponse{400, R"({"error":"malformed request"})"});
        }
```

- [ ] **Step 5: Build and run the tests**

Run: `cmake --build build --target inference_engine_test && cd build && ctest -R HttpServer --output-on-failure`
Expected: PASS — all `HttpServerFixture.*` tests, including the 5 new ones and every pre-existing one (route dispatch, 404, malformed-request handling, Content-Length validation, header parsing/trimming/dedup).

- [ ] **Step 6: Run the full existing suite to check for regressions**

Run: `cd build && ctest --output-on-failure`
Expected: PASS, everything (this task doesn't touch `InferenceEngine`, `node_agent_main.cpp`, or any other file, but `node_agent_test.cpp`'s real subprocess tests link against the same `HttpServer` this changes).

- [ ] **Step 7: Commit**

```bash
git add core/include/swarm/http_server.h core/src/http_server.cpp core/tests/http_server_test.cpp
git commit -m "Add HttpServer streaming support: ResponseWriter, routeStreaming()"
```

---

### Task 3: `swarm-node-agent`'s `/complete` gains `stream: true`

**Files:**
- Modify: `core/include/swarm/json_utils.h`
- Modify: `core/src/json_utils.cpp`
- Modify: `core/src/node_agent_main.cpp`
- Test: `core/tests/json_utils_test.cpp`
- Test: `core/tests/node_agent_test.cpp`

**Interfaces:**
- Consumes: Task 1's `InferenceEngine::completeStreaming()`; Task 2's `HttpServer::routeStreaming()`/`ResponseWriter`.
- Produces: `bool extractJsonBool(const std::string& body, const std::string& key, bool& out)`; `/complete` accepts an optional top-level `"stream": true` field.

- [ ] **Step 1: Write the failing `extractJsonBool` tests**

Add these tests to `core/tests/json_utils_test.cpp`, inside the existing anonymous namespace (the file already includes `<gtest/gtest.h>` and `"swarm/json_utils.h"` — no new includes needed):

```cpp
TEST(JsonUtilsTest, ExtractsABooleanTrue) {
    bool out = false;
    ASSERT_TRUE(swarm::extractJsonBool(R"({"stream":true})", "stream", out));
    EXPECT_TRUE(out);
}

TEST(JsonUtilsTest, ExtractsABooleanFalse) {
    bool out = true;
    ASSERT_TRUE(swarm::extractJsonBool(R"({"stream":false})", "stream", out));
    EXPECT_FALSE(out);
}

TEST(JsonUtilsTest, ExtractJsonBoolReturnsFalseWhenTheKeyIsMissing) {
    bool out = false;
    EXPECT_FALSE(swarm::extractJsonBool(R"({"other":true})", "stream", out));
}

TEST(JsonUtilsTest, ExtractJsonBoolReturnsFalseForAStringValue) {
    bool out = false;
    EXPECT_FALSE(swarm::extractJsonBool(R"({"stream":"true"})", "stream", out));
}

TEST(JsonUtilsTest, ExtractJsonBoolReturnsFalseForANumericValue) {
    bool out = false;
    EXPECT_FALSE(swarm::extractJsonBool(R"({"stream":1})", "stream", out));
}
```

- [ ] **Step 2: Confirm the tests fail to compile**

Run: `cmake --build build --target inference_engine_test`
Expected: FAIL — `extractJsonBool` is not declared.

- [ ] **Step 3: Add `extractJsonBool`**

In `core/include/swarm/json_utils.h`, find:

```cpp
// Escapes `s` for embedding as a JSON string value (without the
// surrounding quotes) -- \", \\, \n, \r, \t, and control characters below
// 0x20 as \u00XX.
std::string jsonEscapeString(const std::string& s);

}  // namespace swarm
```

Replace with:

```cpp
// Extracts the boolean value of a genuinely top-level JSON key, e.g.
// extractJsonBool(R"({"stream":true})", "stream", out) sets out = true and
// returns true. "Top-level" has the same meaning as extractJsonString's
// own definition -- see its comment. Returns false if `key` isn't present
// as a top-level key with a literal `true` or `false` value (a quoted
// "true"/"false" string, or 1/0, do not count).
bool extractJsonBool(const std::string& body, const std::string& key, bool& out);

// Escapes `s` for embedding as a JSON string value (without the
// surrounding quotes) -- \", \\, \n, \r, \t, and control characters below
// 0x20 as \u00XX.
std::string jsonEscapeString(const std::string& s);

}  // namespace swarm
```

In `core/src/json_utils.cpp`, find:

```cpp
std::string jsonEscapeString(const std::string& s) {
```

Replace with:

```cpp
bool extractJsonBool(const std::string& body, const std::string& key, bool& out) {
    size_t colon = findTopLevelKeyColon(body, key);
    if (colon == std::string::npos) {
        return false;
    }
    size_t i = colon + 1;
    while (i < body.size() && std::isspace(static_cast<unsigned char>(body[i]))) {
        ++i;
    }
    if (body.compare(i, 4, "true") == 0) {
        out = true;
        return true;
    }
    if (body.compare(i, 5, "false") == 0) {
        out = false;
        return true;
    }
    return false;
}

std::string jsonEscapeString(const std::string& s) {
```

- [ ] **Step 4: Run the `extractJsonBool` tests**

Run: `cmake --build build --target inference_engine_test && cd build && ctest -R JsonUtilsTest --output-on-failure`
Expected: PASS — all `JsonUtilsTest.*` tests, new and pre-existing.

- [ ] **Step 5: Write the failing node-agent streaming test**

Add this test to `core/tests/node_agent_test.cpp`, directly after the existing `CompleteEndpointReturnsRealGeneratedText` test (around line 300 — find it by its `TEST_F(NodeAgentFixture, CompleteEndpointReturnsRealGeneratedText)` declaration):

```cpp
TEST_F(NodeAgentFixture, CompleteEndpointStreamsRealTokensAsSeparateSseFrames) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8,"stream":true})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;

    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("Content-Type: text/event-stream"), std::string::npos);
    // At least one real "data: " frame must have arrived -- the test model
    // and n_predict=8 keep this fast, and shape (not exact tiny-model
    // output) is what's asserted, matching this repo's existing convention.
    EXPECT_NE(response.find("data: "), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointWithoutStreamFieldBehavesExactlyAsBefore) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;

    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("Content-Type: application/json"), std::string::npos);
    EXPECT_NE(response.find("\"text\":\""), std::string::npos);
    EXPECT_EQ(response.find("text/event-stream"), std::string::npos);
}
```

- [ ] **Step 6: Confirm the tests fail**

Run: `cmake --build build --target inference_engine_test && cd build && ctest -R CompleteEndpointStreamsRealTokens --output-on-failure`
Expected: FAIL — `/complete` doesn't understand `stream` yet, so this request gets handled by the old non-streaming code path and returns `application/json`, not `text/event-stream`.

- [ ] **Step 7: Update `node_agent_main.cpp`**

Find the entire `/complete` route registration:

```cpp
        server.route("POST", "/complete", [&engine, &authToken](const swarm::HttpRequest& req) -> swarm::HttpResponse {
            if (!isAuthorized(req, authToken)) {
                return swarm::HttpResponse{401, R"({"error":"missing or invalid Authorization header"})"};
            }
            std::string prompt;
            if (!swarm::extractJsonString(req.body, "prompt", prompt)) {
                return swarm::HttpResponse{400, R"({"error":"prompt must be a JSON string field"})"};
            }
            int nPredict = 64;
            swarm::extractJsonInt(req.body, "n_predict", nPredict);  // optional -- keep default if absent/malformed
            if (nPredict <= 0) {
                return swarm::HttpResponse{400, R"({"error":"n_predict must be a positive integer"})"};
            }
            // Defense-in-depth cap at the agent level: this process is
            // independently network-reachable, and a large n_predict against
            // InferenceEngine's fixed context size can tie up this
            // single-threaded server for minutes (blocking even /health)
            // before ultimately failing once the context is exhausted,
            // discarding every token generated. Reject outright rather than
            // clamp/truncate, so callers get a clear signal instead of a
            // silently different amount than requested. A future
            // coordinator-side cap (Phase B) is a separate, independent
            // check -- this one does not depend on it existing.
            if (nPredict > 512) {
                return swarm::HttpResponse{400, R"({"error":"n_predict must not exceed 512"})"};
            }

            try {
                std::string text = engine->complete(prompt, nPredict);
                return swarm::HttpResponse{200, R"({"text":")" + swarm::jsonEscapeString(text) + R"("})"};
            } catch (const std::exception& e) {
                return swarm::HttpResponse{500, R"({"error":")" + swarm::jsonEscapeString(e.what()) + R"("})"};
            }
        });
```

Replace it with:

```cpp
        // Moved from route() to routeStreaming(): HttpServer's routing is
        // (method, path) only, so a body field like "stream" can't select
        // between two different registered routes at dispatch time --
        // only this one handler, once selected, can inspect it. The
        // non-streaming branch below calls writer.writeJsonResponse(),
        // which produces byte-for-byte the same wire format this endpoint
        // always has, so no existing caller (including every test that
        // predates this change) sees any difference.
        server.routeStreaming("POST", "/complete", [&engine, &authToken](const swarm::HttpRequest& req, swarm::ResponseWriter& writer) {
            if (!isAuthorized(req, authToken)) {
                writer.writeJsonResponse(401, R"({"error":"missing or invalid Authorization header"})");
                return;
            }
            std::string prompt;
            if (!swarm::extractJsonString(req.body, "prompt", prompt)) {
                writer.writeJsonResponse(400, R"({"error":"prompt must be a JSON string field"})");
                return;
            }
            int nPredict = 64;
            swarm::extractJsonInt(req.body, "n_predict", nPredict);  // optional -- keep default if absent/malformed
            if (nPredict <= 0) {
                writer.writeJsonResponse(400, R"({"error":"n_predict must be a positive integer"})");
                return;
            }
            // Defense-in-depth cap at the agent level: this process is
            // independently network-reachable, and a large n_predict against
            // InferenceEngine's fixed context size can tie up this
            // single-threaded server for minutes (blocking even /health)
            // before ultimately failing once the context is exhausted,
            // discarding every token generated. Reject outright rather than
            // clamp/truncate, so callers get a clear signal instead of a
            // silently different amount than requested. A future
            // coordinator-side cap (Phase B) is a separate, independent
            // check -- this one does not depend on it existing.
            if (nPredict > 512) {
                writer.writeJsonResponse(400, R"({"error":"n_predict must not exceed 512"})");
                return;
            }
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

            // Streaming path: any exception completeStreaming() throws (a
            // genuine C++ exception -- tokenization/decode/context-size
            // failures) propagates out of this handler uncaught.
            // HttpServer::run()'s dispatch loop catches it and turns it
            // into a writer.writeError() SSE frame -- the "signal
            // generation failed partway through" behavior this needs, in
            // one place shared by every streaming handler rather than
            // duplicated here. NOTE: this does NOT cover a remote-RPC node
            // dying (GGML_ABORT) -- that is an uncatchable process abort,
            // not a C++ exception; the whole swarm-node-agent process
            // terminates before any response, streamed or not, could be
            // sent. Same pre-existing, disclosed limitation as the
            // non-streaming path already had (see CLAUDE.md's Phase A
            // section) -- streaming does not fix or worsen it.
            engine->completeStreaming(prompt, nPredict, [&writer](const std::string& piece) {
                writer.writeChunk(piece);
                return true;
            });
        });
```

- [ ] **Step 8: Build and run the new tests**

Run: `cmake --build build --target inference_engine_test && cd build && ctest -R "CompleteEndpointStreams|CompleteEndpointWithoutStream" --output-on-failure`
Expected: PASS.

- [ ] **Step 9: Run the full existing suite to check for regressions**

Run: `cd build && ctest --output-on-failure`
Expected: PASS, everything -- especially every pre-existing `NodeAgentFixture` test (`CompleteEndpointReturnsRealGeneratedText`, the 400/401 rejection tests) and `MultiNodeAgentFixture`'s real RPC-sharded test, none of which set `stream` and must all still see the exact old non-streaming JSON responses.

- [ ] **Step 10: Commit**

```bash
git add core/include/swarm/json_utils.h core/src/json_utils.cpp core/src/node_agent_main.cpp core/tests/json_utils_test.cpp core/tests/node_agent_test.cpp
git commit -m "swarm-node-agent's /complete honors an optional stream:true field"
```

---

### Task 4: Coordinator `POST /generate` gains `stream: true`

**Files:**
- Modify: `coordinator/src/server.ts`
- Test: `coordinator/tests/server.test.ts`

**Interfaces:**
- Consumes: Task 3's `/complete` `stream: true` behavior (tested here against a stub HTTP server that speaks the same SSE dialect, not the real C++ agent -- matching this project's existing coordinator-test convention; the real C++ agent is exercised at the whole-branch-review stage).
- Produces: `/generate` accepts an optional top-level `"stream": true` field. Task 5 depends on the exact wire format this produces (raw passthrough of the node's own `data: .../event: error` SSE bytes).

- [ ] **Step 1: Write the failing tests**

Add this streaming stub helper to `coordinator/tests/server.test.ts`, directly after the existing `startStubNodeAgent` function:

```typescript
// Like startStubNodeAgent, but for a POST /complete request with
// stream: true -- responds with a real SSE stream, writing each of
// `chunks` as its own "data: ...\n\n" frame with `delayMs` between writes,
// so a caller relaying this incrementally (not buffering the whole thing)
// can be told apart from one that isn't.
async function startStreamingStubNodeAgent(chunks: string[], delayMs = 20) {
  const server = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the request body */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of chunks) {
      res.write(`data: ${chunk}\n\n`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected streaming stub node agent to bind to a port");
  }
  return { server, endpoint: `http://127.0.0.1:${address.port}` };
}
```

Add these tests directly after the existing test `"POST /generate excludes a reputation-ejected node from routing"` (the last test in the `/generate` block):

```typescript
test("POST /generate with stream:true relays SSE chunks from the node", async () => {
  const stub = await startStreamingStubNodeAgent(["Paris", " is", " nice"]);
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b", stream: true }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    assert.equal(text, "data: Paris\n\ndata:  is\n\ndata:  nice\n\n");
  } finally {
    server.close();
    stub.server.close();
  }
});

test("POST /generate with stream:true relays chunks as they arrive, not buffered until the end", async () => {
  const stub = await startStreamingStubNodeAgent(["first", "second"], 150);
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b", stream: true }),
    });

    assert.ok(res.body);
    const reader = res.body!.getReader();
    const arrivalTimesMs: number[] = [];
    const start = Date.now();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      arrivalTimesMs.push(Date.now() - start);
    }

    // The stub sleeps 150ms between its two writes -- if the coordinator
    // buffered the whole response before relaying it, all reads would
    // arrive together near the end of the stub's total delay. Real
    // incremental relay means the first read arrives well before the stub
    // has even reached its own inter-chunk sleep.
    assert.ok(arrivalTimesMs.length >= 2, `expected at least 2 separate reads, got ${arrivalTimesMs.length}`);
    assert.ok(
      arrivalTimesMs[0] < 100,
      `first chunk arrived at ${arrivalTimesMs[0]}ms, expected well under the stub's 150ms inter-chunk delay`,
    );
  } finally {
    server.close();
    stub.server.close();
  }
});

test("POST /generate with stream:true still classifies the prompt before contacting any node", async () => {
  const classifier = new KeywordSafetyClassifier([{ category: "test", pattern: /blocked/i }]);
  const { server, baseUrl } = await startTestServer(undefined, undefined, classifier);
  try {
    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "this is blocked", modelId: "tinyllama-1.1b", stream: true }),
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { safe: false, categories: ["test"] });
  } finally {
    server.close();
  }
});

test("POST /generate with stream:true returns a normal 502 when the selected node is unreachable", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:1", deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b", stream: true }),
    });

    assert.equal(res.status, 502);
    assert.equal(res.headers.get("content-type"), "application/json");
  } finally {
    server.close();
  }
});

test("POST /generate without a stream field behaves exactly as before", async () => {
  const stub = await startStubNodeAgent(() => ({ status: 200, body: { text: "Paris." } }));
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b" }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.deepEqual(await res.json(), { text: "Paris." });
  } finally {
    server.close();
    stub.server.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd coordinator && npm test -- --test-name-pattern="stream:true|stream field"`
Expected: FAIL — `/generate` doesn't understand `stream` yet, so a `stream: true` request today falls through to the existing non-streaming path and gets a `200 application/json` `{text: ...}` reply (or hangs waiting on the stub's SSE response as if it were a single JSON body and fails to parse it), not `text/event-stream`.

- [ ] **Step 3: Update `server.ts`**

Find the `modelId` validation inside the `/generate` handler:

```typescript
        if (typeof candidate.modelId !== "string" || !catalog.hasModel(candidate.modelId)) {
          sendJson(res, 400, { error: "modelId must be a known catalog model id" });
          return;
        }
        let nPredict = DEFAULT_N_PREDICT;
```

Replace with:

```typescript
        if (typeof candidate.modelId !== "string" || !catalog.hasModel(candidate.modelId)) {
          sendJson(res, 400, { error: "modelId must be a known catalog model id" });
          return;
        }
        const stream = candidate.stream === true;
        let nPredict = DEFAULT_N_PREDICT;
```

Then find the entire node-forwarding block (from node selection through the end of the handler):

```typescript
        const node = registry.listActive(reputation).find(n => n.servesModel === candidate.modelId);
```

This line was replaced by Phase 4's `selectNode(...)` call — find the CURRENT version instead:

```typescript
        const node = selectNode(registry.listActive(reputation), reputation, candidate.modelId, random);
        if (!node) {
          sendJson(res, 503, { error: `no active node currently serves model "${candidate.modelId}"` });
          return;
        }

        try {
          const nodeRes = await fetch(`${node.endpoint}/complete`, {
            method: "POST",
            headers: { "content-type": "application/json", "authorization": `Bearer ${authToken}` },
            body: JSON.stringify({ prompt: candidate.prompt, n_predict: nPredict }),
            signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
          });
          if (!nodeRes.ok) {
            sendJson(res, 502, { error: `node returned status ${nodeRes.status}` });
            return;
          }
          const nodeBody = await nodeRes.json();
          if (typeof nodeBody.text !== "string") {
            sendJson(res, 502, { error: "node returned a malformed response" });
            return;
          }
          sendJson(res, 200, { text: nodeBody.text });
        } catch (err) {
          console.warn(`failed to forward /generate to node ${node.endpoint}:`, err);
          sendJson(res, 502, { error: "failed to reach the selected node" });
        }
        return;
      }
```

Replace it with:

```typescript
        const node = selectNode(registry.listActive(reputation), reputation, candidate.modelId, random);
        if (!node) {
          sendJson(res, 503, { error: `no active node currently serves model "${candidate.modelId}"` });
          return;
        }

        if (stream) {
          try {
            const nodeRes = await fetch(`${node.endpoint}/complete`, {
              method: "POST",
              headers: { "content-type": "application/json", "authorization": `Bearer ${authToken}` },
              body: JSON.stringify({ prompt: candidate.prompt, n_predict: nPredict, stream: true }),
              signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
            });
            if (!nodeRes.ok || !nodeRes.body) {
              sendJson(res, 502, { error: `node returned status ${nodeRes.status}` });
              return;
            }
            // Raw passthrough, not decode-then-re-encode: both hops speak
            // the identical SSE dialect (this coordinator's own choice, see
            // the Phase D design doc), so the node's bytes are already
            // exactly what this response needs to send -- including any
            // "event: error" frame the node emits mid-stream, which flows
            // through unchanged.
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const reader = nodeRes.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
            res.end();
          } catch (err) {
            console.warn(`failed to forward streaming /generate to node ${node.endpoint}:`, err);
            // If SSE headers haven't gone out yet, a normal error response
            // is still possible; once they have, the only safe recovery is
            // to close the connection -- a fresh 502 can't be layered onto
            // a response that already declared itself a 200 text/event-stream.
            if (!res.headersSent) {
              sendJson(res, 502, { error: "failed to reach the selected node" });
            } else {
              res.end();
            }
          }
          return;
        }

        try {
          const nodeRes = await fetch(`${node.endpoint}/complete`, {
            method: "POST",
            headers: { "content-type": "application/json", "authorization": `Bearer ${authToken}` },
            body: JSON.stringify({ prompt: candidate.prompt, n_predict: nPredict }),
            signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
          });
          if (!nodeRes.ok) {
            sendJson(res, 502, { error: `node returned status ${nodeRes.status}` });
            return;
          }
          const nodeBody = await nodeRes.json();
          if (typeof nodeBody.text !== "string") {
            sendJson(res, 502, { error: "node returned a malformed response" });
            return;
          }
          sendJson(res, 200, { text: nodeBody.text });
        } catch (err) {
          console.warn(`failed to forward /generate to node ${node.endpoint}:`, err);
          sendJson(res, 502, { error: "failed to reach the selected node" });
        }
        return;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd coordinator && npm test -- --test-name-pattern="stream:true|stream field"`
Expected: PASS (all 5 new tests green).

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `cd coordinator && npm test`
Expected: PASS, all tests -- especially every pre-existing `/generate` test (none of which set `stream`, so all must see byte-identical behavior to before this task).

- [ ] **Step 6: Commit**

```bash
git add coordinator/src/server.ts coordinator/tests/server.test.ts
git commit -m "Coordinator's POST /generate honors an optional stream:true field"
```

---

### Task 5: `SwarmClient.generateStream()` and dashboard incremental rendering

**Files:**
- Modify: `coordinator/src/client.ts`
- Test: `coordinator/tests/client.test.ts`
- Modify: `coordinator/public/app.js`

**Interfaces:**
- Consumes: Task 4's `/generate` `stream: true` SSE wire format.
- Produces: nothing consumed by a later task -- this is the last task in this plan.
- **Important note, not obvious from the design doc**: `coordinator/public/app.js` is a plain `<script>`-tag browser file with no bundler and no ES module imports (confirmed: it has zero `import` statements today) -- it CANNOT literally call `SwarmClient.generateStream()` from `client.ts`. This task's dashboard changes therefore implement their own independent SSE-parsing logic in `app.js`, structurally similar to `client.ts`'s but not sharing code with it. Both exist; neither depends on the other.

- [ ] **Step 1: Write the failing `client.ts` test**

First, read `coordinator/tests/client.test.ts` to find its existing test for `generate()` (for exact style/fixture reuse -- this repo's test files are read fresh at each task, not assumed from memory) and add a new test directly after it:

```typescript
test("generateStream yields each SSE chunk's text in order", async () => {
  const server = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: Paris\n\n");
    res.write("data:  is\n\n");
    res.write("data:  nice\n\n");
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected test server to bind a port");
  }
  const client = new SwarmClient(`http://127.0.0.1:${address.port}`, "test-token");
  try {
    const pieces: string[] = [];
    for await (const piece of client.generateStream("hi", "tinyllama-1.1b")) {
      pieces.push(piece);
    }
    assert.deepEqual(pieces, ["Paris", " is", " nice"]);
  } finally {
    server.close();
  }
});

test("generateStream throws when the stream emits an error frame", async () => {
  const server = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: partial\n\n");
    res.write('event: error\ndata: {"error":"node died"}\n\n');
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected test server to bind a port");
  }
  const client = new SwarmClient(`http://127.0.0.1:${address.port}`, "test-token");
  try {
    const pieces: string[] = [];
    await assert.rejects(
      async () => {
        for await (const piece of client.generateStream("hi", "tinyllama-1.1b")) {
          pieces.push(piece);
        }
      },
      /node died/,
    );
    assert.deepEqual(pieces, ["partial"]);
  } finally {
    server.close();
  }
});

test("generateStream reconstructs a multi-line chunk from multiple data: lines in one frame", async () => {
  const server = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: line one\ndata: line two\n\n");
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected test server to bind a port");
  }
  const client = new SwarmClient(`http://127.0.0.1:${address.port}`, "test-token");
  try {
    const pieces: string[] = [];
    for await (const piece of client.generateStream("hi", "tinyllama-1.1b")) {
      pieces.push(piece);
    }
    assert.deepEqual(pieces, ["line one\nline two"]);
  } finally {
    server.close();
  }
});
```

If `createHttpServer` (from `node:http`) isn't already imported in `client.test.ts`, add `import { createServer as createHttpServer } from "node:http";` alongside the file's existing imports.

- [ ] **Step 2: Confirm the tests fail**

Run: `cd coordinator && npm test -- --test-name-pattern="generateStream"`
Expected: FAIL — `client.generateStream is not a function`.

- [ ] **Step 3: Add `generateStream` to `client.ts`**

Find:

```typescript
  async generate(prompt: string, modelId: string, n_predict?: number, signal?: AbortSignal): Promise<{ text: string }> {
    const res = await this.postJson("/generate", { prompt, modelId, n_predict }, signal);
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`generate failed: ${res.status} ${detail}`);
    }
    return res.json();
  }
```

Replace with:

```typescript
  async generate(prompt: string, modelId: string, n_predict?: number, signal?: AbortSignal): Promise<{ text: string }> {
    const res = await this.postJson("/generate", { prompt, modelId, n_predict }, signal);
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`generate failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  // Yields one generated text piece per SSE "data: ..." frame the
  // coordinator relays, in order, as they arrive -- does not buffer the
  // whole reply before the caller sees anything. Throws if the stream
  // emits an "event: error" frame (with that frame's message), or if the
  // initial request itself fails before any streaming could begin.
  async *generateStream(prompt: string, modelId: string, n_predict?: number, signal?: AbortSignal): AsyncGenerator<string> {
    const res = await this.postJson("/generate", { prompt, modelId, n_predict, stream: true }, signal);
    if (!res.ok || !res.body) {
      const detail = await res.text();
      throw new Error(`generateStream failed: ${res.status} ${detail}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? ""; // the last element may be an incomplete frame -- keep it for the next read
      for (const frame of frames) {
        if (frame.startsWith("event: error")) {
          const dataLine = frame.split("\n").find(line => line.startsWith("data: "));
          const message = dataLine ? JSON.parse(dataLine.slice("data: ".length)).error : "generation failed mid-stream";
          throw new Error(`generateStream failed mid-stream: ${message}`);
        }
        const dataLines = frame.split("\n").filter(line => line.startsWith("data: "));
        if (dataLines.length > 0) {
          yield dataLines.map(line => line.slice("data: ".length)).join("\n");
        }
      }
    }
  }
```

- [ ] **Step 4: Run the `client.ts` tests**

Run: `cd coordinator && npm test -- --test-name-pattern="generateStream"`
Expected: PASS (all 3 new tests green).

- [ ] **Step 5: Write the dashboard's incremental rendering (manual verification only -- no automated test)**

`coordinator/public/app.js` has no test coverage beyond `server.test.ts`'s element-ID presence check (unchanged by this step -- no new elements are added, only rendering behavior changes), matching this project's established pattern for dashboard changes: this step is verified live in Step 7 below, not by an automated test.

Find:

```javascript
function renderChatHistory() {
  const historyEl = document.getElementById("chat-history");
  historyEl.innerHTML = "";
  for (const message of chatHistory) {
    const row = document.createElement("div");
    row.className = message.status
      ? `chat-message chat-${message.role} chat-${message.status}`
      : `chat-message chat-${message.role}`;
    row.textContent = message.text;
    historyEl.appendChild(row);
  }
  historyEl.scrollTop = historyEl.scrollHeight;
}
```

Replace with:

```javascript
function renderChatHistory() {
  const historyEl = document.getElementById("chat-history");
  historyEl.innerHTML = "";
  for (const message of chatHistory) {
    const row = document.createElement("div");
    row.className = message.status
      ? `chat-message chat-${message.role} chat-${message.status}`
      : `chat-message chat-${message.role}`;
    row.textContent = message.text;
    historyEl.appendChild(row);
  }
  historyEl.scrollTop = historyEl.scrollHeight;
}

// Appends `piece` directly to the last rendered message's DOM node without
// rebuilding the whole history -- used while a streamed reply is actively
// growing, so a real generation (which can emit dozens of pieces) doesn't
// clear-and-rebuild the entire visible history on every single token.
// renderChatHistory() itself is still used for the FIRST piece of a new
// message (it needs a DOM node to exist before this can append to it) and
// for anything that changes a message's CSS class (an error/blocked
// status), not just its text.
function appendToLastChatMessage(piece) {
  const historyEl = document.getElementById("chat-history");
  const last = historyEl.lastElementChild;
  if (last) {
    last.textContent += piece;
    historyEl.scrollTop = historyEl.scrollHeight;
  }
}
```

Then find the entire `sendChatMessage` function:

```javascript
async function sendChatMessage() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;

  const prompt = buildChatPrompt(text);
  chatHistory.push({ role: "user", text });
  renderChatHistory();
  input.value = "";
  setChatBusy(true);

  const modelId = document.getElementById("chat-model-select").value;
  try {
    const res = await authedFetch("/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, modelId, n_predict: CHAT_N_PREDICT }),
    });
    const body = await res.json();
    if (res.status === 200) {
      chatHistory.push({ role: "assistant", text: body.text.trim() });
    } else if (res.status === 400 && body.safe === false) {
      chatHistory.push({
        role: "assistant",
        text: `Blocked by safety filter (${body.categories.length > 0 ? body.categories.join(", ") : "unspecified"}).`,
        status: "blocked",
      });
    } else if (res.status === 401) {
      chatHistory.push({
        role: "assistant",
        text: "Invalid or missing token — paste a valid SWARM_AUTH_TOKEN above.",
        status: "error",
      });
    } else {
      chatHistory.push({ role: "assistant", text: body.error ?? `Request failed (${res.status}).`, status: "error" });
    }
  } catch (err) {
    chatHistory.push({ role: "assistant", text: "Network error reaching the coordinator.", status: "error" });
    console.error("chat generate request failed", err);
  }
  setChatBusy(false);
  renderChatHistory();
}
```

Replace it with:

```javascript
async function sendChatMessage() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;

  const prompt = buildChatPrompt(text);
  chatHistory.push({ role: "user", text });
  renderChatHistory();
  input.value = "";
  setChatBusy(true);

  const modelId = document.getElementById("chat-model-select").value;
  const assistantMessage = { role: "assistant", text: "" };
  let assistantMessageAdded = false;

  try {
    const res = await authedFetch("/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, modelId, n_predict: CHAT_N_PREDICT, stream: true }),
    });

    if (res.status !== 200) {
      const body = await res.json();
      if (res.status === 400 && body.safe === false) {
        chatHistory.push({
          role: "assistant",
          text: `Blocked by safety filter (${body.categories.length > 0 ? body.categories.join(", ") : "unspecified"}).`,
          status: "blocked",
        });
      } else if (res.status === 401) {
        chatHistory.push({
          role: "assistant",
          text: "Invalid or missing token — paste a valid SWARM_AUTH_TOKEN above.",
          status: "error",
        });
      } else {
        chatHistory.push({ role: "assistant", text: body.error ?? `Request failed (${res.status}).`, status: "error" });
      }
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          if (frame.startsWith("event: error")) {
            const dataLine = frame.split("\n").find(line => line.startsWith("data: "));
            const message = dataLine ? JSON.parse(dataLine.slice("data: ".length)).error : "generation failed mid-stream";
            if (!assistantMessageAdded) {
              chatHistory.push(assistantMessage);
              assistantMessageAdded = true;
            }
            assistantMessage.status = "error";
            assistantMessage.text += assistantMessage.text ? ` [error: ${message}]` : `Error: ${message}`;
            renderChatHistory(); // status changed -- needs the CSS class updated too, not just text
            continue;
          }
          const dataLines = frame.split("\n").filter(line => line.startsWith("data: "));
          if (dataLines.length === 0) continue;
          const piece = dataLines.map(line => line.slice("data: ".length)).join("\n");
          assistantMessage.text += piece;
          if (!assistantMessageAdded) {
            chatHistory.push(assistantMessage);
            assistantMessageAdded = true;
            renderChatHistory(); // first piece -- the DOM node doesn't exist yet
          } else {
            appendToLastChatMessage(piece); // later pieces -- avoid a full rebuild per token
          }
        }
      }
      if (!assistantMessageAdded) {
        chatHistory.push({ role: "assistant", text: "(no output)" });
      }
    }
  } catch (err) {
    if (!assistantMessageAdded) {
      chatHistory.push({ role: "assistant", text: "Network error reaching the coordinator.", status: "error" });
    }
    console.error("chat generate request failed", err);
  }
  setChatBusy(false);
  renderChatHistory();
}
```

- [ ] **Step 6: Run the full coordinator test suite**

Run: `cd coordinator && npm test`
Expected: PASS, all tests -- including the existing `server.test.ts` element-ID test (unaffected: no HTML elements changed) and every `client.test.ts`/`server.test.ts` test from Tasks 4 and 5.

- [ ] **Step 7: Manual live-browser verification**

This project's established practice for UI changes, and the only real verification the streaming *rendering* itself works (no automated test drives a browser). From the repo root:

```bash
SWARM_AUTH_TOKEN=stream-verify PORT=18370 node coordinator/src/main.ts &
sleep 1
SWARM_AUTH_TOKEN=stream-verify ./build/core/swarm-node-agent.exe --model models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf --port 8082 &
sleep 2
curl -s -X POST http://127.0.0.1:18370/nodes/register \
  -H "authorization: Bearer stream-verify" -H "content-type: application/json" \
  -d '{"endpoint":"http://127.0.0.1:8082","deviceTier":"desktop","servesModel":"tinyllama-1.1b"}'
echo
echo "Now open http://127.0.0.1:18370 in a real browser."
```

In the browser: paste `stream-verify`, save the token, confirm the chat panel's model dropdown lists `TinyLlama 1.1B`. Send a message and watch closely -- confirm text visibly appears progressively (word by word / piece by piece), not in one jump at the end after a long wait (the tell-tale sign of accidentally-still-buffered delivery). Send a follow-up to confirm multi-turn context still works exactly as it did non-streaming (this task didn't touch `buildChatPrompt`). Stop the node agent mid-conversation and send another message -- confirm an inline error message appears in the chat (not a hang, not a raw uncaught-exception in the browser console with nothing shown to the user).

When done:

```bash
kill %1 %2
```

Confirm no orphaned process remains: `tasklist //FI "IMAGENAME eq node.exe" //FO CSV` and `tasklist //FI "IMAGENAME eq swarm-node-agent.exe" //FO CSV` should both show nothing from this check.

- [ ] **Step 8: Commit**

```bash
git add coordinator/src/client.ts coordinator/tests/client.test.ts coordinator/public/app.js
git commit -m "Add SwarmClient.generateStream() and dashboard incremental streaming rendering"
```

---

## What this plan does not do

- **Cancellation.** A client disconnecting mid-stream still leaves the node finishing generation with nobody listening -- unchanged, pre-existing behavior, not newly introduced or newly fixed.
- **Speculative decoding streaming.** `complete_speculative()`/`SpeculativeResult` are untouched.
- **Sampling parameter support** (`temperature`, `top_p`, etc.) -- the engine's sampler remains greedy-only, unrelated to and unchanged by this plan.
- **Fixing the `GGML_ABORT`-on-dead-remote-device limitation.** Still an uncatchable process-level abort, not a C++ exception; streaming's error-frame mechanism cannot and does not cover it. Exactly as disclosed before this plan.
- **The OpenAI-compatible `/v1/chat/completions` endpoint.** This plan only builds the streaming plumbing; a separate, already-sketched plan wires an OpenAI-shaped endpoint on top of it (real streaming *and* real token counts, both now possible once this merges), deliberately sequenced after this one.
- **Bounded-read/SIGPIPE cap re-tuning.** Task 2 preserves the existing 16 KiB header / 10 MiB body caps and SIGPIPE-ignore posture unchanged; whether a long-lived streaming connection needs different limits is real follow-up work this plan doesn't attempt (see the design doc's Open Questions).
