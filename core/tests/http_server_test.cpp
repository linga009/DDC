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

}  // namespace
