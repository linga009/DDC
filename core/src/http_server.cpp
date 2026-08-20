#include "swarm/http_server.h"

#include <cctype>
#include <csignal>
#include <cstdint>
#include <map>
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

// Generous for a JSON prompt body, small enough to bound memory use from a
// single connection.
constexpr size_t kMaxRequestBodyBytes = 10 * 1024 * 1024;  // 10 MiB

// Generous for a small, fixed set of headers this server expects, small
// enough to bound memory use from a connection that never sends a
// terminator.
constexpr size_t kMaxHeaderBytes = 16 * 1024;  // 16 KiB

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
        if (data.size() > kMaxHeaderBytes) {
            throw std::runtime_error("request headers too large");
        }
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
    std::map<std::string, std::string> headers;
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
    // The plain method.empty()/path.empty() check only rejects lines with
    // fewer than two whitespace-separated tokens -- a garbage line like
    // "NOT A REQUEST" still parses as three non-empty tokens and would
    // otherwise be silently accepted as method="NOT" path="A" version=
    // "REQUEST". Requiring the third token to look like an HTTP version
    // catches that case while still accepting every well-formed request
    // line (e.g. "GET /health HTTP/1.1").
    if (result.method.empty() || result.path.empty() || httpVersion.compare(0, 5, "HTTP/") != 0) {
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
        std::string value = headerLine.substr(colon + 1);
        size_t firstNonSpace = value.find_first_not_of(" \t");
        value = (firstNonSpace == std::string::npos) ? std::string() : value.substr(firstNonSpace);
        result.headers[name] = value;

        if (name == "content-length") {
            if (value.empty()) {
                continue;
            }
            if (value[0] == '-') {
                // std::stoul accepts a leading '-' and silently wraps it
                // into a huge unsigned value (per strtoul's documented
                // behavior) instead of throwing -- reject explicitly so
                // "Content-Length: -5" is treated as malformed rather
                // than as a request to read billions of bytes of body.
                throw std::runtime_error("invalid Content-Length");
            }
            unsigned long parsed = std::stoul(value);
            if (parsed > kMaxRequestBodyBytes) {
                throw std::runtime_error(
                    "Content-Length exceeds maximum allowed request body size");
            }
            result.contentLength = static_cast<size_t>(parsed);
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
                              : response.status == 401 ? "Unauthorized"
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
#ifndef _WIN32
    // Writing to a socket after the peer has reset the connection raises
    // SIGPIPE on POSIX, whose default disposition terminates the whole
    // process -- not just the current connection. Ignore it once here (run()
    // is only ever called once, at process startup, and blocks forever) so a
    // client that disconnects early just yields a normal failed send()
    // instead of killing the server. No-op on Windows, where the equivalent
    // failure is already a plain SOCKET_ERROR return.
    signal(SIGPIPE, SIG_IGN);
#endif

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

        closeSocket(client);
    }
}

}  // namespace swarm
