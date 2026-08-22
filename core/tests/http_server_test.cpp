#include "swarm/http_server.h"

#include <gtest/gtest.h>

#include <chrono>
#include <cstring>
#include <string>
#include <thread>
#include <type_traits>
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

// The SSE spec defines a line as terminated by "\r\n", "\r", OR "\n" -- all
// three, not just "\n". A bare '\r' (which a BPE vocabulary can genuinely
// emit, and Phase D streams raw detokenized model output) left raw inside a
// `data: ` line therefore does NOT reach an EventSource-compliant parser as
// text: the parser ends the line at the '\r' and then reads "after" as a
// malformed field name, silently discarding it. The word is lost from the
// stream entirely, with no error anywhere. Splitting on '\r' exactly the way
// '\n' is already split keeps both halves on the wire and readable.
TEST_F(HttpServerFixture, StreamingRouteSplitsAChunkOnABareCarriageReturnToo) {
    swarm::HttpServer server(kTestPort + 16);
    server.routeStreaming("POST", "/stream", [](const swarm::HttpRequest&, swarm::ResponseWriter& writer) {
        writer.writeChunk("before\rafter");
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 16, "POST /stream HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");

    EXPECT_NE(response.find("data: before\ndata: after\n\n"), std::string::npos);

    // Belt and braces: no raw '\r' may survive anywhere inside the frame --
    // a surviving one is precisely what truncates the event for a real
    // parser. (Everything before the frame is the header block, whose own
    // CRLFs are legitimate, so scan only from the frame's start.)
    size_t frameStart = response.find("data: before");
    ASSERT_NE(frameStart, std::string::npos);
    EXPECT_EQ(response.find('\r', frameStart), std::string::npos);
}

// The other half of the same rule: "\r\n" is ONE line terminator, not two.
// Splitting on '\r' and '\n' independently would emit a spurious empty
// `data: ` line between the two words, which a compliant parser decodes as
// an extra blank line in the event's text ("before\n\nafter") -- corrupting
// the model's output rather than losing it.
TEST_F(HttpServerFixture, StreamingRouteTreatsCrlfAsOneLineBreakNotTwo) {
    swarm::HttpServer server(kTestPort + 17);
    server.routeStreaming("POST", "/stream", [](const swarm::HttpRequest&, swarm::ResponseWriter& writer) {
        writer.writeChunk("before\r\nafter");
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 17, "POST /stream HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");

    EXPECT_NE(response.find("data: before\ndata: after\n\n"), std::string::npos);
    size_t frameStart = response.find("data: before");
    ASSERT_NE(frameStart, std::string::npos);
    EXPECT_EQ(response.find('\r', frameStart), std::string::npos);
}

// The zero-chunk stream is a REAL, reachable case, not a synthetic one: an
// instruct model handed an already-complete turn emits its end-of-generation
// token as the very first token, so InferenceEngine::completeStreaming()
// breaks before ever invoking its callback and the handler never calls
// writeChunk(). Because SSE headers are sent lazily on first write, that
// used to put literally ZERO bytes on the wire -- run() just closed the
// socket, and a real client (verified with curl) reported "Empty reply from
// server", indistinguishable from a crashed process. run() now calls
// writeDone() after any streaming handler that returns normally, so even a
// stream with no content is a well-formed 200 that terminates explicitly.
TEST_F(HttpServerFixture, StreamingRouteThatWritesNothingStillSendsADoneTerminatedResponse) {
    swarm::HttpServer server(kTestPort + 18);
    server.routeStreaming("POST", "/stream", [](const swarm::HttpRequest&, swarm::ResponseWriter&) {
        // Writes nothing at all -- a generation that produced zero tokens.
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 18, "POST /stream HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");

    EXPECT_FALSE(response.empty());
    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("Content-Type: text/event-stream"), std::string::npos);
    EXPECT_NE(response.find("data: [DONE]\n\n"), std::string::npos);
}

// The `data: [DONE]\n\n` sentinel is the same one real OpenAI-compatible
// streaming APIs use, and it must come LAST -- a client reading frames in
// order treats it as "the stream completed successfully, no more content is
// coming", which is only true if no further frame follows it.
TEST_F(HttpServerFixture, StreamingRouteAppendsADoneFrameAfterTheLastChunk) {
    swarm::HttpServer server(kTestPort + 19);
    server.routeStreaming("POST", "/stream", [](const swarm::HttpRequest&, swarm::ResponseWriter& writer) {
        writer.writeChunk("alpha");
        writer.writeChunk("beta");
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 19, "POST /stream HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");

    size_t alpha = response.find("data: alpha\n\n");
    size_t beta = response.find("data: beta\n\n");
    size_t done = response.find("data: [DONE]\n\n");
    ASSERT_NE(alpha, std::string::npos);
    ASSERT_NE(beta, std::string::npos);
    ASSERT_NE(done, std::string::npos);
    EXPECT_LT(alpha, beta);
    EXPECT_LT(beta, done);
    // Nothing at all after the sentinel -- it is the final frame on the wire.
    EXPECT_EQ(done + std::strlen("data: [DONE]\n\n"), response.size());
}

// A failure that happens BEFORE any byte has been written is still a normal
// HTTP error: the status line hasn't been committed yet, so a real
// `500 application/json` is available and matches byte-for-byte what the
// same failure produces on this endpoint's non-streaming path. Committing to
// a `200 text/event-stream` just to carry an error frame would tell every
// client "this request succeeded" about a request that never started.
TEST_F(HttpServerFixture, StreamingHandlerThatThrowsBeforeWritingAnythingGetsAJsonErrorNotAnSseStream) {
    swarm::HttpServer server(kTestPort + 20);
    server.routeStreaming("POST", "/stream", [](const swarm::HttpRequest&, swarm::ResponseWriter&) {
        throw std::runtime_error("prompt too long");
    });
    startServer(server);

    std::string response = sendRawRequest(kTestPort + 20, "POST /stream HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");

    EXPECT_NE(response.find("HTTP/1.1 500"), std::string::npos);
    EXPECT_NE(response.find("Content-Type: application/json"), std::string::npos);
    EXPECT_NE(response.find(R"({"error":"prompt too long"})"), std::string::npos);
    EXPECT_EQ(response.find("text/event-stream"), std::string::npos);
    EXPECT_EQ(response.find("event: error"), std::string::npos);
    // A failed request must never claim success, by any route.
    EXPECT_EQ(response.find("[DONE]"), std::string::npos);
}

// A ResponseWriter tracks, in its own members, whether SSE headers or a
// complete JSON response have already gone out on its socket -- state that
// is only correct if exactly one object owns it for the life of the
// response. A copy carries a snapshot of those flags and then diverges: a
// handler that captured the writer by value into a callback ([writer]
// instead of the correct [&writer]) would mutate a throwaway whose
// sseHeadersSent_/jsonResponseSent_ updates never propagate back, and the
// real object would go on re-emitting SSE headers mid-stream -- silent wire
// corruption with no exception and no failed send. Deleting the copy
// operations turns that whole bug class into a compile error at the point
// the bad capture is written.
TEST(ResponseWriterTest, IsNotCopyable) {
    EXPECT_FALSE(std::is_copy_constructible<swarm::ResponseWriter>::value);
    EXPECT_FALSE(std::is_copy_assignable<swarm::ResponseWriter>::value);
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
    // The success sentinel and the error frame are mutually exclusive: run()
    // calls writeDone() only on the path where the handler RETURNED, never
    // on the path where it threw. A stream that ended in an error must not
    // also announce "[DONE]" -- that would tell the client the generation
    // completed successfully when it was cut short partway through.
    EXPECT_EQ(response.find("[DONE]"), std::string::npos);
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
    // writeDone() runs after EVERY streaming handler that returns normally,
    // including this one -- but a handler that chose a plain JSON response
    // has nothing streaming to terminate, so writeDone() must be a no-op
    // there. Appending anything after a Content-Length-delimited body would
    // corrupt the wire for every non-streaming caller of a
    // routeStreaming()-registered endpoint (which is exactly what
    // swarm-node-agent's /complete is without "stream": true).
    EXPECT_EQ(response.find("[DONE]"), std::string::npos);
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
