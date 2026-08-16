# swarm-node-agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `swarm-node-agent`, a long-lived C++ executable that loads a model once (as a single-device, remote-device, or layer-placement `InferenceEngine`, exactly as Plans 1/2/4 already built) and serves it over a minimal HTTP interface, so the coordinator (Plan 13, not this plan) can route a prompt to it and get a real generated response back.

**Architecture:** Three independently-testable pieces, in dependency order: (1) `HttpServer` — a minimal, hand-rolled, cross-platform (Windows Winsock / POSIX sockets) blocking HTTP/1.1 server that serves a small, fixed set of exact-match routes, with zero knowledge of JSON or inference; (2) `json_utils` — minimal, purpose-built JSON field extraction (not a general parser — this project has no JSON library dependency on the C++ side, matching `core/`'s existing zero-unnecessary-dependency stance) for the exact shapes this project's own JSON producers emit; (3) `swarm-node-agent`'s `main()`, which wires the two together with `InferenceEngine`.

**Tech Stack:** C++17, the existing `inference_engine` library target, no new external dependencies (raw sockets via Winsock2/POSIX, no HTTP or JSON library).

## Global Constraints

- Everything from Plans 1/2/4's Global Constraints still applies: C++17, use llama.cpp's raw API only (already satisfied — this plan doesn't touch `InferenceEngine` internals, only wraps it), member declaration order matters when backing storage for llama.cpp pointers is involved (not relevant to this plan — no new `InferenceEngine` construction patterns beyond calling its existing three public constructors).
- `HttpServer` is a fixed-route server, not a general one: exact `(method, path)` string match only, no wildcards, no query-string parsing, no path parameters. It exists to serve exactly `swarm-node-agent`'s two endpoints (Task 3) — do not build it more generally than that.
- `json_utils`'s functions are field extractors for known, expected key names in a flat JSON object — not a general JSON parser. They must handle exactly what this project's own JSON producers (the coordinator's `JSON.stringify`, and this plan's own response-writing code) ever emit: `\"`, `\\`, `\n` string escapes; plain (possibly negative) integers. Anything more general is out of scope.
- One connection at a time, no concurrency, no keep-alive, no clean shutdown path (`HttpServer::run()` blocks forever, matching `swarm-rpc-server`'s existing "blocks forever" behavior in this repo) — all disclosed limitations from the design spec (`docs/superpowers/specs/2026-08-16-request-routing-design.md`), not gaps to solve in this plan.

---

### Task 1: `HttpServer` — minimal cross-platform blocking HTTP server

**Files:**
- Create: `core/include/swarm/http_server.h`
- Create: `core/src/http_server.cpp`
- Create: `core/tests/http_server_test.cpp`
- Modify: `core/CMakeLists.txt`
- Modify: `core/tests/CMakeLists.txt`

**Interfaces:**
- Consumes: nothing from this project — raw sockets only (Winsock2 on Windows via `<winsock2.h>`/`<ws2tcpip.h>`, POSIX sockets elsewhere via `<sys/socket.h>` etc.).
- Produces:
  ```cpp
  namespace swarm {

  struct HttpRequest {
      std::string method;
      std::string path;
      std::string body;
  };

  struct HttpResponse {
      int status = 200;
      std::string body;
  };

  using HttpHandler = std::function<HttpResponse(const HttpRequest&)>;

  class HttpServer {
  public:
      explicit HttpServer(int port);
      void route(const std::string& method, const std::string& path, HttpHandler handler);
      void run();  // blocks forever
  private:
      int port_;
      std::vector<std::tuple<std::string, std::string, HttpHandler>> routes_;
  };

  }  // namespace swarm
  ```
  Task 3 consumes `HttpServer`, `route()`, and `run()` directly.

- [ ] **Step 1: Create the header**

Create `core/include/swarm/http_server.h`:

```cpp
#pragma once

#include <functional>
#include <string>
#include <tuple>
#include <vector>

namespace swarm {

struct HttpRequest {
    std::string method;
    std::string path;
    std::string body;
};

struct HttpResponse {
    int status = 200;
    std::string body;
};

using HttpHandler = std::function<HttpResponse(const HttpRequest&)>;

// Minimal, blocking, single-connection-at-a-time HTTP/1.1 server. Serves
// only routes registered via route() -- exact (method, path) string match,
// no wildcards, no query strings, no path parameters. Every response is
// sent with Content-Type: application/json and the connection is closed
// immediately after (no keep-alive). This exists to be one process's
// small, fixed local API surface, not a general-purpose web server -- do
// not extend it toward one.
class HttpServer {
public:
    explicit HttpServer(int port);

    // Registers a handler for an exact (method, path) pair. Must be called
    // before run(). Later routes do not override earlier ones with the
    // same (method, path) -- the first match wins.
    void route(const std::string& method, const std::string& path, HttpHandler handler);

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
};

}  // namespace swarm
```

- [ ] **Step 2: Create the implementation**

Create `core/src/http_server.cpp`:

```cpp
#include "swarm/http_server.h"

#include <cctype>
#include <cstdint>
#include <sstream>
#include <stdexcept>
#include <utility>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
using socket_t = SOCKET;
static constexpr socket_t kInvalidSocket = INVALID_SOCKET;
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
using socket_t = int;
static constexpr socket_t kInvalidSocket = -1;
#endif

namespace swarm {

namespace {

void closeSocket(socket_t s) {
#ifdef _WIN32
    closesocket(s);
#else
    close(s);
#endif
}

// recv()/send() return `int` on Windows and `ssize_t` on POSIX -- these
// wrappers normalize both to a signed type wide enough for either, so the
// rest of this file doesn't need platform conditionals.
long long recvBytes(socket_t s, char* buf, size_t len) {
#ifdef _WIN32
    return ::recv(s, buf, static_cast<int>(len), 0);
#else
    return static_cast<long long>(::recv(s, buf, len, 0));
#endif
}

long long sendBytes(socket_t s, const char* buf, size_t len) {
#ifdef _WIN32
    return ::send(s, buf, static_cast<int>(len), 0);
#else
    return static_cast<long long>(::send(s, buf, len, 0));
#endif
}

// Reads from `s` until a "\r\n\r\n" header terminator is found, returning
// everything read so far -- which may include body bytes that arrived in
// the same read as the terminator (HTTP doesn't guarantee headers and body
// arrive in separate reads). Throws std::runtime_error if the peer closes
// before a complete header block arrives.
std::string readUntilHeadersEnd(socket_t s) {
    std::string data;
    char buf[4096];
    while (data.find("\r\n\r\n") == std::string::npos) {
        long long n = recvBytes(s, buf, sizeof(buf));
        if (n <= 0) {
            throw std::runtime_error("connection closed before headers completed");
        }
        data.append(buf, static_cast<size_t>(n));
    }
    return data;
}

struct ParsedHead {
    std::string method;
    std::string path;
    size_t contentLength = 0;
};

// Parses the request line and headers out of `head` (which starts at the
// beginning of a request and contains at least one "\r\n\r\n"). Sets
// `bodySoFar` to whatever came after the header terminator in the same
// buffer.
ParsedHead parseHead(const std::string& head, std::string& bodySoFar) {
    size_t headerEnd = head.find("\r\n\r\n");
    std::string headerBlock = head.substr(0, headerEnd);
    bodySoFar = head.substr(headerEnd + 4);

    std::istringstream stream(headerBlock);
    std::string requestLine;
    std::getline(stream, requestLine);
    if (!requestLine.empty() && requestLine.back() == '\r') {
        requestLine.pop_back();
    }

    ParsedHead result;
    std::istringstream requestLineStream(requestLine);
    std::string httpVersion;
    requestLineStream >> result.method >> result.path >> httpVersion;
    if (result.method.empty() || result.path.empty()) {
        throw std::runtime_error("malformed request line");
    }

    std::string headerLine;
    while (std::getline(stream, headerLine)) {
        if (!headerLine.empty() && headerLine.back() == '\r') {
            headerLine.pop_back();
        }
        size_t colon = headerLine.find(':');
        if (colon == std::string::npos) {
            continue;
        }
        std::string name = headerLine.substr(0, colon);
        for (char& c : name) {
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        }
        if (name == "content-length") {
            std::string value = headerLine.substr(colon + 1);
            size_t firstDigit = value.find_first_not_of(" \t");
            if (firstDigit != std::string::npos) {
                result.contentLength = static_cast<size_t>(std::stoul(value.substr(firstDigit)));
            }
        }
    }
    return result;
}

std::string readBody(socket_t s, std::string bodySoFar, size_t contentLength) {
    std::string body = std::move(bodySoFar);
    char buf[4096];
    while (body.size() < contentLength) {
        long long n = recvBytes(s, buf, sizeof(buf));
        if (n <= 0) {
            throw std::runtime_error("connection closed before body completed");
        }
        body.append(buf, static_cast<size_t>(n));
    }
    body.resize(contentLength);
    return body;
}

void writeResponse(socket_t s, const HttpResponse& response) {
    const char* statusText = response.status == 200 ? "OK"
                              : response.status == 404 ? "Not Found"
                              : response.status == 400 ? "Bad Request"
                                                        : "Error";
    std::ostringstream out;
    out << "HTTP/1.1 " << response.status << " " << statusText << "\r\n"
        << "Content-Type: application/json\r\n"
        << "Content-Length: " << response.body.size() << "\r\n"
        << "Connection: close\r\n"
        << "\r\n"
        << response.body;
    std::string data = out.str();
    size_t sent = 0;
    while (sent < data.size()) {
        long long n = sendBytes(s, data.data() + sent, data.size() - sent);
        if (n <= 0) {
            return;  // peer gone -- nothing more we can do
        }
        sent += static_cast<size_t>(n);
    }
}

}  // namespace

HttpServer::HttpServer(int port) : port_(port) {}

void HttpServer::route(const std::string& method, const std::string& path, HttpHandler handler) {
    routes_.emplace_back(method, path, std::move(handler));
}

void HttpServer::run() {
#ifdef _WIN32
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);
#endif

    socket_t listenSocket = socket(AF_INET, SOCK_STREAM, 0);
    if (listenSocket == kInvalidSocket) {
        throw std::runtime_error("failed to create socket");
    }

    int reuse = 1;
    setsockopt(listenSocket, SOL_SOCKET, SO_REUSEADDR,
               reinterpret_cast<const char*>(&reuse), sizeof(reuse));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(static_cast<uint16_t>(port_));

    if (bind(listenSocket, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        closeSocket(listenSocket);
        throw std::runtime_error("failed to bind port " + std::to_string(port_));
    }
    if (listen(listenSocket, /*backlog=*/16) != 0) {
        closeSocket(listenSocket);
        throw std::runtime_error("failed to listen on port " + std::to_string(port_));
    }

    for (;;) {
        socket_t client = accept(listenSocket, nullptr, nullptr);
        if (client == kInvalidSocket) {
            continue;
        }

        try {
            std::string head = readUntilHeadersEnd(client);
            std::string bodySoFar;
            ParsedHead parsed = parseHead(head, bodySoFar);
            std::string body = readBody(client, std::move(bodySoFar), parsed.contentLength);

            HttpRequest request{parsed.method, parsed.path, body};

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

        closeSocket(client);
    }
}

}  // namespace swarm
```

- [ ] **Step 3: Write the failing tests**

Create `core/tests/http_server_test.cpp`:

```cpp
#include "swarm/http_server.h"

#include <gtest/gtest.h>

#include <chrono>
#include <cstring>
#include <string>
#include <thread>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
using socket_t = SOCKET;
static constexpr socket_t kInvalidSocket = INVALID_SOCKET;
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
using socket_t = int;
static constexpr socket_t kInvalidSocket = -1;
#endif

namespace {

void closeTestSocket(socket_t s) {
#ifdef _WIN32
    closesocket(s);
#else
    close(s);
#endif
}

// Minimal raw-socket test client: connects to 127.0.0.1:port, sends
// `rawRequest` verbatim, reads until the peer closes the connection (this
// server always closes after one response, so read-until-EOF is a valid
// way to capture the full response), and returns what it read.
std::string sendRawRequest(int port, const std::string& rawRequest) {
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

    std::string response;
    char buf[4096];
    for (;;) {
        int n = recv(s, buf, sizeof(buf), 0);
        if (n <= 0) break;
        response.append(buf, static_cast<size_t>(n));
    }
    closeTestSocket(s);
    return response;
}

class HttpServerFixture : public ::testing::Test {
protected:
    // A fixed test-only port. Tests in this file run sequentially within
    // one process (GoogleTest's default), and each test starts its own
    // server on its own thread, so reusing one port across tests is safe
    // as long as each test's server thread has bound the port before the
    // test's client connects -- the sleep below covers that.
    static constexpr int kTestPort = 50099;

    void startServer(swarm::HttpServer& server) {
        std::thread([&server]() { server.run(); }).detach();
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
};

TEST_F(HttpServerFixture, RoutesAGetRequestToItsHandler) {
    swarm::HttpServer server(kTestPort);
    server.route("GET", "/health", [](const swarm::HttpRequest&) {
        return swarm::HttpResponse{200, R"({"status":"ready"})"};
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n");

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find(R"({"status":"ready"})"), std::string::npos);
}

TEST_F(HttpServerFixture, PassesThePostBodyToItsHandler) {
    swarm::HttpServer server(kTestPort + 1);
    std::string capturedBody;
    server.route("POST", "/echo", [&capturedBody](const swarm::HttpRequest& req) {
        capturedBody = req.body;
        return swarm::HttpResponse{200, R"({"ok":true})"};
    });
    startServer(server);

    std::string body = R"({"hello":"world"})";
    std::string request = "POST /echo HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\n\r\n" + body;
    sendRawRequest(kTestPort + 1, request);

    EXPECT_EQ(capturedBody, body);
}

TEST_F(HttpServerFixture, ReturnsA404ForAnUnregisteredRoute) {
    swarm::HttpServer server(kTestPort + 2);
    server.route("GET", "/health", [](const swarm::HttpRequest&) {
        return swarm::HttpResponse{200, "{}"};
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 2, "GET /nonexistent HTTP/1.1\r\nHost: x\r\n\r\n");

    EXPECT_NE(response.find("HTTP/1.1 404"), std::string::npos);
}

TEST_F(HttpServerFixture, ReturnsA400ForAMalformedRequestLine) {
    swarm::HttpServer server(kTestPort + 3);
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 3, "NOT A REQUEST\r\n\r\n");

    EXPECT_NE(response.find("HTTP/1.1 400"), std::string::npos);
}

}  // namespace
```

Run:
```bash
cmake --build build --target inference_engine_test
```
Expected: **FAIL** to compile (`swarm/http_server.h` doesn't exist yet) — this confirms Step 1/2 haven't been added to the build yet; proceed to Step 4 to wire them in, then re-run.

- [ ] **Step 4: Wire into the build**

Modify `core/CMakeLists.txt` — add `src/http_server.cpp` to the `inference_engine` library's sources, and link the Windows sockets library on Windows only:

```cmake
add_library(inference_engine
    src/inference_engine.cpp
    src/speculative.cpp
    src/http_server.cpp
)
target_include_directories(inference_engine PUBLIC include)
target_link_libraries(inference_engine PUBLIC llama)
target_compile_features(inference_engine PUBLIC cxx_std_17)
if(WIN32)
    target_link_libraries(inference_engine PUBLIC ws2_32)
endif()
```

(This replaces the existing `add_library(inference_engine ...)` block — keep the `swarm-cli`/`swarm-rpc-server`/`add_subdirectory(tests)` lines below it unchanged.)

Modify `core/tests/CMakeLists.txt` — add the new test file to `inference_engine_test`'s sources:

```cmake
add_executable(inference_engine_test inference_engine_test.cpp speculative_test.cpp http_server_test.cpp)
```

(This replaces the existing `add_executable(inference_engine_test ...)` line only — leave every other line in this file unchanged.)

- [ ] **Step 5: Build and run the tests**

```bash
cmake --build build --target inference_engine_test
cd build && ctest -R HttpServerFixture --output-on-failure
```
Expected: **PASS** — all 4 new tests.

- [ ] **Step 6: Commit**

```bash
git add core/include/swarm/http_server.h core/src/http_server.cpp core/tests/http_server_test.cpp core/CMakeLists.txt core/tests/CMakeLists.txt
git commit -m "Add HttpServer: minimal cross-platform blocking HTTP server for core/"
```

---

### Task 2: `json_utils` — minimal JSON field extraction

**Files:**
- Create: `core/include/swarm/json_utils.h`
- Create: `core/src/json_utils.cpp`
- Create: `core/tests/json_utils_test.cpp`
- Modify: `core/CMakeLists.txt`
- Modify: `core/tests/CMakeLists.txt`

**Interfaces:**
- Consumes: nothing from this project.
- Produces:
  ```cpp
  namespace swarm {
  bool extractJsonString(const std::string& body, const std::string& key, std::string& out);
  bool extractJsonInt(const std::string& body, const std::string& key, int& out);
  std::string jsonEscapeString(const std::string& s);
  }
  ```
  Task 3 consumes all three functions directly.

- [ ] **Step 1: Create the header**

Create `core/include/swarm/json_utils.h`:

```cpp
#pragma once

#include <string>

namespace swarm {

// Extracts the string value of a top-level JSON key from `body`, e.g.
// extractJsonString(R"({"prompt":"hi \"there\""})", "prompt", out) sets
// out = "hi \"there\"" and returns true. Returns false if `key` isn't
// present as a top-level key with a string value. Handles \", \\, and \n
// escapes only -- the set this project's own JSON producers (the
// coordinator's JSON.stringify, and this project's own response-writing
// code) ever emit; this is a purpose-built field extractor, not a general
// JSON parser, and must not be extended toward one.
bool extractJsonString(const std::string& body, const std::string& key, std::string& out);

// Extracts the integer value of a top-level JSON key, e.g.
// extractJsonInt(R"({"n_predict":64})", "n_predict", out) sets out = 64
// and returns true. Handles an optional leading '-'. Returns false if
// `key` isn't present as a top-level key with an integer value.
bool extractJsonInt(const std::string& body, const std::string& key, int& out);

// Escapes `s` for embedding as a JSON string value (without the
// surrounding quotes) -- \", \\, \n, \r, \t, and control characters below
// 0x20 as \u00XX.
std::string jsonEscapeString(const std::string& s);

}  // namespace swarm
```

- [ ] **Step 2: Write the failing tests**

Create `core/tests/json_utils_test.cpp`:

```cpp
#include "swarm/json_utils.h"

#include <gtest/gtest.h>

namespace {

TEST(JsonUtilsTest, ExtractsASimpleStringValue) {
    std::string out;
    ASSERT_TRUE(swarm::extractJsonString(R"({"prompt":"hello"})", "prompt", out));
    EXPECT_EQ(out, "hello");
}

TEST(JsonUtilsTest, ExtractsAStringValueWithEscapedQuotesAndNewline) {
    std::string out;
    ASSERT_TRUE(swarm::extractJsonString(R"({"prompt":"say \"hi\"\nnow"})", "prompt", out));
    EXPECT_EQ(out, "say \"hi\"\nnow");
}

TEST(JsonUtilsTest, ReturnsFalseWhenTheKeyIsMissing) {
    std::string out;
    EXPECT_FALSE(swarm::extractJsonString(R"({"other":"x"})", "prompt", out));
}

TEST(JsonUtilsTest, ExtractsAPositiveInteger) {
    int out = 0;
    ASSERT_TRUE(swarm::extractJsonInt(R"({"n_predict":64})", "n_predict", out));
    EXPECT_EQ(out, 64);
}

TEST(JsonUtilsTest, ExtractsANegativeInteger) {
    int out = 0;
    ASSERT_TRUE(swarm::extractJsonInt(R"({"n_predict":-5})", "n_predict", out));
    EXPECT_EQ(out, -5);
}

TEST(JsonUtilsTest, ReturnsFalseWhenTheIntKeyIsMissing) {
    int out = 0;
    EXPECT_FALSE(swarm::extractJsonInt(R"({"other":1})", "n_predict", out));
}

TEST(JsonUtilsTest, WorksWithBothKeysInTheSameObjectRegardlessOfOrder) {
    std::string prompt;
    int n = 0;
    std::string body = R"({"n_predict":32,"prompt":"hi"})";
    ASSERT_TRUE(swarm::extractJsonInt(body, "n_predict", n));
    ASSERT_TRUE(swarm::extractJsonString(body, "prompt", prompt));
    EXPECT_EQ(n, 32);
    EXPECT_EQ(prompt, "hi");
}

TEST(JsonUtilsTest, EscapesQuotesBackslashesAndNewlinesForJsonEmbedding) {
    EXPECT_EQ(swarm::jsonEscapeString("say \"hi\"\\now\n"), R"(say \"hi\"\\now\n)");
}

TEST(JsonUtilsTest, RoundTripsAnEscapedStringBackThroughExtraction) {
    std::string original = "line one\nline \"two\"\\ end";
    std::string body = R"({"prompt":")" + swarm::jsonEscapeString(original) + R"("})";
    std::string out;
    ASSERT_TRUE(swarm::extractJsonString(body, "prompt", out));
    EXPECT_EQ(out, original);
}

}  // namespace
```

Run:
```bash
cmake --build build --target inference_engine_test
```
Expected: **FAIL** to compile (`swarm/json_utils.h` doesn't exist yet).

- [ ] **Step 3: Implement**

Create `core/src/json_utils.cpp`:

```cpp
#include "swarm/json_utils.h"

#include <cctype>
#include <cstdio>

namespace swarm {

bool extractJsonString(const std::string& body, const std::string& key, std::string& out) {
    std::string needle = "\"" + key + "\"";
    size_t keyPos = body.find(needle);
    if (keyPos == std::string::npos) {
        return false;
    }
    size_t colon = body.find(':', keyPos + needle.size());
    if (colon == std::string::npos) {
        return false;
    }
    size_t quoteStart = body.find('"', colon);
    if (quoteStart == std::string::npos) {
        return false;
    }

    std::string result;
    size_t i = quoteStart + 1;
    while (i < body.size() && body[i] != '"') {
        if (body[i] == '\\' && i + 1 < body.size()) {
            char next = body[i + 1];
            if (next == '"') { result += '"'; i += 2; continue; }
            if (next == '\\') { result += '\\'; i += 2; continue; }
            if (next == 'n') { result += '\n'; i += 2; continue; }
        }
        result += body[i];
        ++i;
    }
    if (i >= body.size()) {
        return false;  // unterminated string
    }
    out = result;
    return true;
}

bool extractJsonInt(const std::string& body, const std::string& key, int& out) {
    std::string needle = "\"" + key + "\"";
    size_t keyPos = body.find(needle);
    if (keyPos == std::string::npos) {
        return false;
    }
    size_t colon = body.find(':', keyPos + needle.size());
    if (colon == std::string::npos) {
        return false;
    }
    size_t i = colon + 1;
    while (i < body.size() && std::isspace(static_cast<unsigned char>(body[i]))) {
        ++i;
    }
    size_t numStart = i;
    if (i < body.size() && body[i] == '-') {
        ++i;
    }
    while (i < body.size() && std::isdigit(static_cast<unsigned char>(body[i]))) {
        ++i;
    }
    if (i == numStart || (i == numStart + 1 && body[numStart] == '-')) {
        return false;
    }
    out = std::stoi(body.substr(numStart, i - numStart));
    return true;
}

std::string jsonEscapeString(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

}  // namespace swarm
```

- [ ] **Step 4: Wire into the build**

Modify `core/CMakeLists.txt`'s `inference_engine` library sources to add `src/json_utils.cpp`:

```cmake
add_library(inference_engine
    src/inference_engine.cpp
    src/speculative.cpp
    src/http_server.cpp
    src/json_utils.cpp
)
```

Modify `core/tests/CMakeLists.txt`'s `inference_engine_test` sources to add `json_utils_test.cpp`:

```cmake
add_executable(inference_engine_test inference_engine_test.cpp speculative_test.cpp http_server_test.cpp json_utils_test.cpp)
```

- [ ] **Step 5: Build and run the tests**

```bash
cmake --build build --target inference_engine_test
cd build && ctest -R JsonUtilsTest --output-on-failure
```
Expected: **PASS** — all 9 new tests.

- [ ] **Step 6: Commit**

```bash
git add core/include/swarm/json_utils.h core/src/json_utils.cpp core/tests/json_utils_test.cpp core/CMakeLists.txt core/tests/CMakeLists.txt
git commit -m "Add json_utils: minimal JSON field extraction for core/"
```

---

### Task 3: `swarm-node-agent` executable

**Files:**
- Create: `core/src/node_agent_main.cpp`
- Create: `core/tests/node_agent_test.cpp`
- Modify: `core/CMakeLists.txt`
- Modify: `core/tests/CMakeLists.txt`
- Modify: `README.md`

**Interfaces:**
- Consumes: `swarm::HttpServer`/`route()`/`run()` (Task 1), `swarm::extractJsonString`/`extractJsonInt`/`jsonEscapeString` (Task 2), `swarm::InferenceEngine`'s three existing constructors and `complete()` (Plans 1/2/4, unchanged).
- Produces: the `swarm-node-agent` executable. Nothing in this repo consumes it programmatically yet — Plan 13 (not part of this plan) is the first real caller, via HTTP.

- [ ] **Step 1: Implement**

Create `core/src/node_agent_main.cpp`:

```cpp
#include "swarm/http_server.h"
#include "swarm/inference_engine.h"
#include "swarm/json_utils.h"

#include <cstdio>
#include <exception>
#include <memory>
#include <string>
#include <vector>

namespace {

// Parses "N:endpoint" into a swarm::LayerPlacement, e.g.
// "0:127.0.0.1:50052" -> {layer=0, device_endpoint="127.0.0.1:50052"}.
// Throws std::runtime_error if `spec` doesn't contain a colon after a
// leading integer.
swarm::LayerPlacement parseLayerPlacement(const std::string& spec) {
    size_t colon = spec.find(':');
    if (colon == std::string::npos) {
        throw std::runtime_error("--layer-placement must be in the form N:endpoint (got \"" + spec + "\")");
    }
    int layer = std::stoi(spec.substr(0, colon));
    std::string endpoint = spec.substr(colon + 1);
    if (endpoint.empty()) {
        throw std::runtime_error("--layer-placement endpoint must not be empty (got \"" + spec + "\")");
    }
    return swarm::LayerPlacement{layer, endpoint};
}

}  // namespace

int main(int argc, char** argv) {
    std::string modelPath;
    int port = 0;
    std::vector<std::string> remoteEndpoints;
    std::vector<swarm::LayerPlacement> layerPlacements;

    try {
        for (int i = 1; i < argc; ++i) {
            std::string arg = argv[i];
            if (arg == "--model" && i + 1 < argc) {
                modelPath = argv[++i];
            } else if (arg == "--port" && i + 1 < argc) {
                port = std::stoi(argv[++i]);
            } else if (arg == "--remote" && i + 1 < argc) {
                remoteEndpoints.push_back(argv[++i]);
            } else if (arg == "--layer-placement" && i + 1 < argc) {
                layerPlacements.push_back(parseLayerPlacement(argv[++i]));
            } else {
                std::fprintf(stderr, "unrecognized argument: %s\n", arg.c_str());
                return 1;
            }
        }

        if (modelPath.empty() || port <= 0) {
            std::fprintf(stderr,
                         "usage: %s --model <path.gguf> --port N "
                         "[--remote host:port ...] [--layer-placement N:endpoint ...]\n",
                         argv[0]);
            return 1;
        }

        std::printf("swarm-node-agent: loading model %s ...\n", modelPath.c_str());
        std::fflush(stdout);

        // Choose the constructor matching what was actually given, exactly
        // mirroring InferenceEngine's three existing overloads (Plans 1/2/4)
        // -- no new construction logic here.
        std::unique_ptr<swarm::InferenceEngine> engine;
        if (!layerPlacements.empty()) {
            engine = std::make_unique<swarm::InferenceEngine>(modelPath, remoteEndpoints, layerPlacements);
        } else if (!remoteEndpoints.empty()) {
            engine = std::make_unique<swarm::InferenceEngine>(modelPath, remoteEndpoints);
        } else {
            engine = std::make_unique<swarm::InferenceEngine>(modelPath);
        }

        std::printf("swarm-node-agent: ready, serving on 127.0.0.1:%d\n", port);
        std::fflush(stdout);

        swarm::HttpServer server(port);

        server.route("GET", "/health", [](const swarm::HttpRequest&) {
            return swarm::HttpResponse{200, R"({"status":"ready"})"};
        });

        server.route("POST", "/complete", [&engine](const swarm::HttpRequest& req) -> swarm::HttpResponse {
            std::string prompt;
            if (!swarm::extractJsonString(req.body, "prompt", prompt)) {
                return swarm::HttpResponse{400, R"({"error":"prompt must be a JSON string field"})"};
            }
            int nPredict = 64;
            swarm::extractJsonInt(req.body, "n_predict", nPredict);  // optional -- keep default if absent/malformed
            if (nPredict <= 0) {
                return swarm::HttpResponse{400, R"({"error":"n_predict must be a positive integer"})"};
            }

            try {
                std::string text = engine->complete(prompt, nPredict);
                return swarm::HttpResponse{200, R"({"text":")" + swarm::jsonEscapeString(text) + R"("})"};
            } catch (const std::exception& e) {
                return swarm::HttpResponse{500, R"({"error":")" + swarm::jsonEscapeString(e.what()) + R"("})"};
            }
        });

        server.run();  // blocks forever
        return 0;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "error: %s\n", e.what());
        return 1;
    }
}
```

- [ ] **Step 2: Wire into the build**

Modify `core/CMakeLists.txt` — add the new executable below the existing `swarm-rpc-server` block:

```cmake
add_executable(swarm-node-agent src/node_agent_main.cpp)
target_link_libraries(swarm-node-agent PRIVATE inference_engine)
```

(Insert this after the existing `add_executable(swarm-rpc-server ...)` / `target_link_libraries(swarm-rpc-server ...)` lines, before `add_subdirectory(tests)`.)

- [ ] **Step 3: Write the failing tests**

Read `core/tests/inference_engine_test.cpp`'s `RpcServerFixture` class in full first (lines ~26-70 as of Plan 2) to match its exact subprocess-spawn/kill pattern before writing the new fixture below — the `KillAnyRunningServer`-style helpers, the `start /B`/`&` detached-launch commands, and the `SWARM_RPC_SERVER_PATH` compile-definition pattern are all established precedent to reuse, not reinvent.

Create `core/tests/node_agent_test.cpp`:

```cpp
#include <gtest/gtest.h>

#include <chrono>
#include <cstdlib>
#include <string>
#include <thread>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
using socket_t = SOCKET;
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
using socket_t = int;
#endif

#ifndef SWARM_TEST_MODEL_DIR
#define SWARM_TEST_MODEL_DIR "models"
#endif

namespace {

std::string testModelPath() {
    return std::string(SWARM_TEST_MODEL_DIR) + "/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf";
}

std::string sendRawRequest(int port, const std::string& rawRequest) {
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
#ifdef _WIN32
        closesocket(s);
#else
        close(s);
#endif
        throw std::runtime_error("test client failed to connect to node agent on port " + std::to_string(port));
    }

    send(s, rawRequest.data(), static_cast<int>(rawRequest.size()), 0);

    std::string response;
    char buf[4096];
    for (;;) {
        int n = recv(s, buf, sizeof(buf), 0);
        if (n <= 0) break;
        response.append(buf, static_cast<size_t>(n));
    }
#ifdef _WIN32
    closesocket(s);
#else
    close(s);
#endif
    return response;
}

class NodeAgentFixture : public ::testing::Test {
protected:
    static constexpr int kAgentPort = 50098;

    static void KillAnyRunningAgent() {
#ifdef _WIN32
        std::system("taskkill /F /IM swarm-node-agent.exe > NUL 2>&1");
#else
        std::system("pkill -f swarm-node-agent > /dev/null 2>&1");
#endif
    }

    void SetUp() override {
        KillAnyRunningAgent();

        std::string cmd;
#ifdef _WIN32
        cmd = "start /B \"\" \"" SWARM_NODE_AGENT_PATH "\" --model \"" + testModelPath() +
              "\" --port " + std::to_string(kAgentPort) + " > NUL 2>&1";
#else
        cmd = "\"" SWARM_NODE_AGENT_PATH "\" --model \"" + testModelPath() +
              "\" --port " + std::to_string(kAgentPort) + " > /dev/null 2>&1 &";
#endif
        std::system(cmd.c_str());
        // Model load takes real time -- poll /health rather than a fixed
        // sleep, so this fixture doesn't flake on a slower machine or
        // under-sleep on a faster one.
        waitForHealth();
    }

    void TearDown() override {
        KillAnyRunningAgent();
    }

    void waitForHealth() {
        for (int attempt = 0; attempt < 100; ++attempt) {
            try {
                std::string response = sendRawRequest(kAgentPort, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
                if (response.find("HTTP/1.1 200") != std::string::npos) {
                    return;
                }
            } catch (const std::exception&) {
                // not up yet -- keep polling
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }
        FAIL() << "swarm-node-agent did not become healthy within 20 seconds";
    }
};

TEST_F(NodeAgentFixture, HealthEndpointReportsReady) {
    std::string response = sendRawRequest(kAgentPort, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("\"status\":\"ready\""), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointReturnsRealGeneratedText) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("\"text\":\""), std::string::npos);
    // The test model is tiny and the output isn't asserted for content
    // (matching this repo's existing InferenceEngine tests, which check
    // shape/behavior, not exact tiny-model output) -- only that real,
    // non-empty generated text came back through the full HTTP round-trip.
    size_t textStart = response.find("\"text\":\"") + 8;
    size_t textEnd = response.find('"', textStart);
    ASSERT_NE(textEnd, std::string::npos);
    EXPECT_GT(textEnd - textStart, 0u);
}

TEST_F(NodeAgentFixture, CompleteEndpointRejectsAMissingPromptWith400) {
    std::string body = R"({"n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 400"), std::string::npos);
}

}  // namespace
```

Run:
```bash
cmake --build build --target inference_engine_test
```
Expected: **FAIL** to compile (`SWARM_NODE_AGENT_PATH` isn't defined yet, `swarm-node-agent` target doesn't build-depend on the test target yet) — proceed to Step 4.

- [ ] **Step 4: Wire the test into the build**

Modify `core/tests/CMakeLists.txt`: add `node_agent_test.cpp` to `inference_engine_test`'s sources, add the `SWARM_NODE_AGENT_PATH` compile definition, and add the build-order dependency (mirroring the existing `SWARM_RPC_SERVER_PATH`/`add_dependencies(inference_engine_test swarm-rpc-server)` pattern immediately below it):

```cmake
add_executable(inference_engine_test inference_engine_test.cpp speculative_test.cpp http_server_test.cpp json_utils_test.cpp node_agent_test.cpp)
target_link_libraries(inference_engine_test PRIVATE inference_engine GTest::gtest_main)
target_compile_definitions(inference_engine_test PRIVATE
    SWARM_TEST_MODEL_DIR="${CMAKE_SOURCE_DIR}/models"
    SWARM_MOE_TEST_MODEL_DIR="${CMAKE_SOURCE_DIR}/models"
)
target_compile_definitions(inference_engine_test PRIVATE
    SWARM_RPC_SERVER_PATH="$<TARGET_FILE:swarm-rpc-server>"
)
add_dependencies(inference_engine_test swarm-rpc-server)
target_compile_definitions(inference_engine_test PRIVATE
    SWARM_NODE_AGENT_PATH="$<TARGET_FILE:swarm-node-agent>"
)
add_dependencies(inference_engine_test swarm-node-agent)
```

(This replaces the existing `add_executable`/`target_link_libraries`/first two `target_compile_definitions`/first `add_dependencies` block — keep the trailing `include(GoogleTest)` / `gtest_discover_tests(inference_engine_test)` lines unchanged.)

- [ ] **Step 5: Build and run the tests**

```bash
cmake --build build --target inference_engine_test
cd build && ctest -R NodeAgentFixture --output-on-failure
```
Expected: **PASS** — all 3 new tests. This is the slowest test in the suite (spawns a real process, loads a real model) — expect it to take several seconds, not milliseconds.

- [ ] **Step 6: Update README**

Add a "Node agent" subsection to `README.md`, near the existing "Networking and RPC sharding" section, documenting: `swarm-node-agent`'s CLI (`--model`, `--port`, repeatable `--remote`, repeatable `--layer-placement`), its two HTTP endpoints (`GET /health`, `POST /complete` with the `{prompt, n_predict}` → `{text}` shape), that it's a long-lived process serving one request at a time with no built-in concurrency or clean shutdown, and that nothing in this repo talks to it yet — Plan 13 (coordinator request routing) is the first real caller.

- [ ] **Step 7: Commit**

```bash
git add core/src/node_agent_main.cpp core/tests/node_agent_test.cpp core/CMakeLists.txt core/tests/CMakeLists.txt README.md
git commit -m "Add swarm-node-agent: long-lived HTTP-served InferenceEngine process"
```

---

## What this plan does not do

Does not add concurrency, request queueing, authentication, or a clean-shutdown path to `swarm-node-agent` — one request at a time, runs until killed, matching `swarm-rpc-server`'s existing disclosed posture in this repo. Does not change anything about how `InferenceEngine` itself constructs or shards a model — this plan only adds an HTTP-reachable process wrapping its existing, unchanged public API. Does not wire anything in the coordinator to call this agent — that is Plan 13, a separate, independently-reviewed plan, so `swarm-node-agent` can be fully built, tested, and merged before the Node.js side depends on it.
