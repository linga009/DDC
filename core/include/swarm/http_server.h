#pragma once

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
