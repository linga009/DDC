#include "swarm/http_server.h"

#include <gtest/gtest.h>

#include <chrono>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

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

TEST_F(HttpServerFixture, ReturnsA400ForANegativeContentLength) {
    swarm::HttpServer server(kTestPort + 4);
    server.route("POST", "/echo", [](const swarm::HttpRequest&) {
        return swarm::HttpResponse{200, R"({"ok":true})"};
    });
    startServer(server);

    // "-5" must be rejected outright rather than accepted by std::stoul's
    // silent unsigned wraparound (which would otherwise turn it into a
    // request to read billions of bytes of body).
    std::string request = "POST /echo HTTP/1.1\r\nContent-Length: -5\r\n\r\n";
    std::string response = sendRawRequest(kTestPort + 4, request);

    EXPECT_NE(response.find("HTTP/1.1 400"), std::string::npos);
}

TEST_F(HttpServerFixture, ReturnsA400ForAContentLengthAboveTheMaximum) {
    swarm::HttpServer server(kTestPort + 5);
    server.route("POST", "/echo", [](const swarm::HttpRequest&) {
        return swarm::HttpResponse{200, R"({"ok":true})"};
    });
    startServer(server);

    // Rejection must happen from the header value alone (before the server
    // tries to read that much body), so it's safe to send no body bytes at
    // all and still expect a 400.
    std::string request = "POST /echo HTTP/1.1\r\nContent-Length: 999999999\r\n\r\n";
    std::string response = sendRawRequest(kTestPort + 5, request);

    EXPECT_NE(response.find("HTTP/1.1 400"), std::string::npos);
}

TEST_F(HttpServerFixture, ReturnsA400ForHeadersExceedingTheSizeCap) {
    swarm::HttpServer server(kTestPort + 6);
    startServer(server);

    // A single oversized header line, and no "\r\n\r\n" terminator anywhere
    // -- this must trip the header-size cap rather than hang forever or grow
    // memory unbounded waiting for a terminator that never arrives.
    std::string request = "GET /health HTTP/1.1\r\nX-Padding: " + std::string(20 * 1024, 'a');
    std::string response = sendRawRequest(kTestPort + 6, request);

    EXPECT_NE(response.find("HTTP/1.1 400"), std::string::npos);
}

TEST_F(HttpServerFixture, ParsesRequestHeadersIntoTheHandler) {
    swarm::HttpServer server(kTestPort + 7);
    std::string capturedAuth;
    bool foundHeader = false;
    server.route("GET", "/health", [&capturedAuth, &foundHeader](const swarm::HttpRequest& req) {
        auto it = req.headers.find("authorization");
        foundHeader = it != req.headers.end();
        if (foundHeader) {
            capturedAuth = it->second;
        }
        return swarm::HttpResponse{200, "{}"};
    });
    startServer(server);

    sendRawRequest(kTestPort + 7, "GET /health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer abc123\r\n\r\n");

    EXPECT_TRUE(foundHeader);
    EXPECT_EQ(capturedAuth, "Bearer abc123");
}

TEST_F(HttpServerFixture, TrimsTrailingWhitespaceFromAHeaderValue) {
    swarm::HttpServer server(kTestPort + 8);
    std::string capturedAuth;
    server.route("GET", "/health", [&capturedAuth](const swarm::HttpRequest& req) {
        auto it = req.headers.find("authorization");
        if (it != req.headers.end()) {
            capturedAuth = it->second;
        }
        return swarm::HttpResponse{200, "{}"};
    });
    startServer(server);

    // Trailing OWS (a space and a tab here). RFC 7230 3.2.4 says a parser
    // strips it on both sides; Node's parser does, so the coordinator
    // accepts this request. If this side only trimmed the leading side, the
    // same request would carry a *different* token value here and fail auth
    // -- the two implementations would disagree.
    sendRawRequest(kTestPort + 8, "GET /health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer abc123 \t\r\n\r\n");

    EXPECT_EQ(capturedAuth, "Bearer abc123");
}

TEST_F(HttpServerFixture, KeepsTheFirstOfTwoDuplicateHeaders) {
    swarm::HttpServer server(kTestPort + 9);
    std::string capturedAuth;
    server.route("GET", "/health", [&capturedAuth](const swarm::HttpRequest& req) {
        auto it = req.headers.find("authorization");
        if (it != req.headers.end()) {
            capturedAuth = it->second;
        }
        return swarm::HttpResponse{200, "{}"};
    });
    startServer(server);

    // Node's parser keeps the FIRST Authorization header, so the coordinator
    // judges this request on "Bearer first". This server must reach the same
    // verdict -- a last-wins map assignment here would mean a single request
    // could be rejected by one hop and accepted by the other.
    sendRawRequest(kTestPort + 9,
                   "GET /health HTTP/1.1\r\nHost: x\r\n"
                   "Authorization: Bearer first\r\n"
                   "Authorization: Bearer second\r\n\r\n");

    EXPECT_EQ(capturedAuth, "Bearer first");
}

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

// Pins the ACTUAL cross-table precedence rule, because it is not the
// "first registration wins" one might assume: run() scans streamingRoutes_
// before routes_, so registering the same (method, path) via route() FIRST
// and routeStreaming() second still dispatches to the streaming handler.
// Neither registration call rejects or overrides the other -- the loser is
// simply unreachable. This test exists so the header comment documenting
// that rule is backed by observed behavior rather than assumption.
TEST_F(HttpServerFixture, AStreamingRouteTakesPrecedenceOverASameKeyRegularRouteRegisteredFirst) {
    swarm::HttpServer server(kTestPort + 15);
    bool regularHandlerRan = false;
    server.route("POST", "/both", [&regularHandlerRan](const swarm::HttpRequest&) {
        regularHandlerRan = true;
        return swarm::HttpResponse{200, R"({"from":"regular"})"};
    });
    server.routeStreaming("POST", "/both", [](const swarm::HttpRequest&, swarm::ResponseWriter& writer) {
        writer.writeChunk("from streaming");
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 15, "POST /both HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");

    EXPECT_NE(response.find("text/event-stream"), std::string::npos);
    EXPECT_NE(response.find("data: from streaming\n\n"), std::string::npos);
    EXPECT_EQ(response.find(R"({"from":"regular"})"), std::string::npos);
    EXPECT_FALSE(regularHandlerRan);
}

}  // namespace
