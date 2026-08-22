#include "swarm/http_server.h"
#include "swarm/json_utils.h"

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
        // Strip the optional whitespace (OWS) on BOTH sides of the field
        // value, per RFC 7230 section 3.2.4. Trimming only the leading side
        // would make `Authorization: Bearer <token> ` (one trailing space,
        // trivially introduced by a hand-edited config or a copy-paste)
        // compare unequal to the same token here while Node's parser -- and
        // therefore the coordinator -- trims it and accepts it. The two
        // sides of this project must agree on what a header value is.
        size_t firstNonSpace = value.find_first_not_of(" \t");
        if (firstNonSpace == std::string::npos) {
            value.clear();
        } else {
            size_t lastNonSpace = value.find_last_not_of(" \t");
            value = value.substr(firstNonSpace, lastNonSpace - firstNonSpace + 1);
        }

        // First occurrence wins, for every header: `headers[name] = value`
        // would let a LAST-wins duplicate header override an earlier one,
        // while Node's parser (and therefore the coordinator) keeps the
        // FIRST `Authorization` it sees. A request smuggling two different
        // Authorization headers must be judged identically by both
        // implementations, so ignore any repeat rather than overwrite. This
        // covers Content-Length too: the first value parsed below is the one
        // that governs the body read, so a second one can't retroactively
        // change how much body this server expects.
        if (!result.headers.emplace(name, value).second) {
            continue;
        }

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
    if (doneSent_ || errorSent_) {
        // The stream already sent its terminal frame ([DONE] or an error) --
        // writing more content now would put it after the stream's own
        // terminator, which no compliant client is still reading for.
        return;
    }
    socket_t s = static_cast<socket_t>(socketHandle_);
    std::ostringstream out;
    size_t start = 0;
    for (;;) {
        // The SSE spec terminates a line on "\r\n", "\r", OR "\n" -- all
        // three, so all three must become a separate `data: ` line here. A
        // bare '\r' left raw inside a line (a BPE vocabulary can genuinely
        // emit one, and this streams raw detokenized model output) would end
        // the line at the parser anyway, and everything after it on that line
        // would be read as a malformed field name and silently discarded --
        // losing real generated text with no error on either side.
        size_t brk = text.find_first_of("\r\n", start);
        std::string line = (brk == std::string::npos) ? text.substr(start) : text.substr(start, brk - start);
        out << "data: " << line << "\n";
        if (brk == std::string::npos) {
            break;
        }
        // "\r\n" is ONE terminator, not two: consume both bytes together, or
        // the '\n' would start another (empty) line and inject a spurious
        // blank line into the event's decoded text.
        bool isCrlf = text[brk] == '\r' && brk + 1 < text.size() && text[brk + 1] == '\n';
        start = brk + (isCrlf ? 2 : 1);
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

void ResponseWriter::writeDone() {
    if (jsonResponseSent_) {
        // The handler chose a plain, complete JSON response -- there is no
        // stream to terminate, and appending anything after a
        // Content-Length-delimited body would corrupt the wire for every
        // non-streaming caller of a routeStreaming()-registered endpoint.
        return;
    }
    if (doneSent_) {
        return;  // one stream, one terminal sentinel
    }
    if (errorSent_) {
        // The stream already ended in failure -- appending a success
        // sentinel after an error frame would tell a client the same stream
        // both failed and completed successfully.
        return;
    }
    // Deliberately BEFORE the send, not after: a handler that already streamed
    // real content and then loses the peer must not leave this false and
    // invite a second sentinel attempt from a later caller.
    doneSent_ = true;
    // Unconditionally ensures headers first -- this is the whole point of the
    // method. A generation that emitted its end-of-generation token as its
    // very first token (a normal case for an instruct model handed an
    // already-complete turn) never calls writeChunk(), so without this the
    // lazily-sent SSE headers would never go out at all and the client would
    // get zero bytes: an empty reply indistinguishable from a crashed server.
    ensureSseHeadersSent();
    socket_t s = static_cast<socket_t>(socketHandle_);
    static const char kDoneFrame[] = "data: [DONE]\n\n";
    size_t len = sizeof(kDoneFrame) - 1;  // exclude the trailing '\0'
    size_t sentTotal = 0;
    while (sentTotal < len) {
        long long n = sendBytes(s, kDoneFrame + sentTotal, len - sentTotal);
        if (n <= 0) {
            throw std::runtime_error("failed to write SSE completion marker: peer gone");
        }
        sentTotal += static_cast<size_t>(n);
    }
}

void ResponseWriter::writeError(const std::string& message) {
    if (jsonResponseSent_) {
        return;  // already committed to a response -- see ensureSseHeadersSent's comment
    }
    if (!sseHeadersSent_) {
        // Nothing has been sent to the client yet -- a real error status is
        // still possible and matches the non-streaming path's behavior for
        // the identical failure, instead of committing to a 200
        // text/event-stream just to report a failure that happened before
        // any generation began. (A too-long prompt rejected during
        // tokenization is the live example: the same request without
        // "stream": true already gets exactly this 500 + JSON body.)
        writeJsonResponse(500, R"({"error":")" + jsonEscapeString(message) + R"("})");
        return;
    }
    if (doneSent_ || errorSent_) {
        // The stream already ended (a [DONE] sentinel or a prior error frame
        // already went out) -- a second terminal frame now would corrupt the
        // wire by telling the client the same stream ended twice.
        return;
    }
    errorSent_ = true;
    // Already streaming -- the only way left to signal failure is an SSE
    // error frame; the status line and Content-Type are already committed
    // and cannot be changed now.
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

            bool matchedStreaming = false;
            for (const auto& routeEntry : streamingRoutes_) {
                if (std::get<0>(routeEntry) == parsed.method && std::get<1>(routeEntry) == parsed.path) {
                    matchedStreaming = true;
                    ResponseWriter writer(static_cast<intptr_t>(client));
                    try {
                        std::get<2>(routeEntry)(request, writer);
                        // Only on the path where the handler RETURNED, never
                        // where it threw: `[DONE]` means "completed
                        // successfully", so a stream that ended via
                        // writeError() below must not also claim it. This
                        // placement is what makes the three outcomes of a
                        // streaming response distinguishable on the wire --
                        // clean completion (including zero chunks) ends with
                        // `data: [DONE]`, a genuine C++ exception ends with
                        // `event: error`, and an outright process abort (the
                        // disclosed, uncatchable GGML_ABORT-on-dead-remote
                        // case) ends with neither, which is the honest signal
                        // for it.
                        writer.writeDone();
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

        closeSocket(client);
    }
}

}  // namespace swarm
