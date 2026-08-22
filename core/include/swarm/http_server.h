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
// one-or-more calls to writeChunk()/writeError()/writeDone() may be made on
// a given ResponseWriter -- whichever is called first commits this response
// to being either a normal single JSON response or an SSE stream; any
// further call (of either kind) after that is a silent no-op, since a
// response's status line and headers can only be sent once. writeError() is
// the one exception to the "first call picks SSE" rule, and deliberately
// so: called when nothing has been sent yet, it picks the plain JSON form
// (a real 500), because a failure with no committed status line does not
// need a stream to report it. This lets one
// streaming-registered route serve both a plain, unchanged non-streaming
// response (when a handler determines, after inspecting the request, that
// this particular call shouldn't actually stream) and a real SSE stream,
// from the same registration -- HttpServer's routing is (method, path)
// only, so a request body field can't be used to pick between two
// DIFFERENT registered routes at dispatch time; it can only be inspected
// by the one handler routing already selected.
//
// Once an SSE stream has ended -- via writeDone() sending its [DONE]
// sentinel or writeError() sending its terminal error frame -- it stays
// ended: writeChunk()/writeDone()/writeError() are all silent no-ops for
// the rest of this object's life. This is enforced by the doneSent_/
// errorSent_ flags below, not merely a documented calling convention a
// handler must follow: a handler that calls writeError() itself (rather
// than letting an exception propagate to HttpServer::run(), which is the
// only call site in this codebase today) and then keeps writing cannot put
// content or a second terminal frame on the wire after the stream already
// declared itself over.
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
    // one `data: <text>\n\n` frame. A `text` containing an embedded line
    // break is sent as multiple consecutive `data: ` lines belonging to the
    // same event, per the SSE spec's own multi-line convention -- otherwise
    // the embedded break would look like the frame's own terminator to a
    // spec-compliant SSE parser. All three of the spec's line terminators
    // count as a break here -- "\r\n", a bare "\r", and a bare "\n" -- with
    // "\r\n" treated as one break rather than two. A bare '\r' matters as
    // much as '\n' because a BPE vocabulary can emit one in real
    // detokenized output, and a raw '\r' inside a `data: ` line silently
    // truncates the event at a compliant parser: everything after it on
    // that line is read as a malformed field name and discarded. A silent
    // no-op if the stream already ended (writeDone() or writeError() already
    // sent its terminal frame) -- see the class comment above. Throws
    // std::runtime_error if the underlying send fails (peer gone).
    void writeChunk(const std::string& text);

    // Sends SSE headers if not already sent (guaranteeing a well-formed,
    // non-empty response even for a generation that produced zero chunks),
    // then a terminal `data: [DONE]\n\n` frame -- the defined way to signal
    // "this stream completed successfully; there is no more content coming."
    // A no-op if a plain JSON response was already sent via writeJsonResponse
    // (nothing streaming-related to terminate), or if the stream already
    // ended -- via a prior writeDone() call, or because writeError() already
    // sent a terminal error frame (a stream cannot both fail and succeed on
    // the same wire). Matches the same sentinel real OpenAI-compatible
    // streaming APIs use. Throws std::runtime_error if the underlying send
    // fails (peer gone).
    //
    // HttpServer::run() calls this automatically, exactly once, after a
    // StreamingHttpHandler returns normally -- handlers do not need to call
    // it, and calling it again is a no-op (the second call would otherwise
    // put a second sentinel on the wire, telling a client the stream ended
    // twice).
    void writeDone();

    // Signals failure. If NOTHING has been sent yet, this is still an
    // ordinary HTTP error: a real `500 application/json` response, matching
    // byte-for-byte what the non-streaming path produces for the identical
    // failure, rather than committing to a 200 text/event-stream purely to
    // carry an error frame for a request that never began streaming.
    // Once a stream IS underway, the status line and Content-Type are
    // already committed and cannot be changed, so the only way left to
    // signal failure is one terminal
    // `event: error\ndata: {"error":"<message>"}\n\n` frame -- the defined
    // way to say "generation failed" after real content may already have
    // been delivered. A no-op if the stream already ended (a prior
    // writeError() call already sent this frame, or writeDone() already sent
    // its [DONE] sentinel -- a stream cannot both succeed and fail on the
    // same wire). Throws std::runtime_error if the underlying send fails.
    //
    // Note the SSE branch needs NO line-break splitting of its own: the
    // message goes through jsonEscapeString(), which already turns a '\r'
    // into a literal backslash-r inside the JSON string, so it cannot put a
    // raw '\r' on the wire the way writeChunk() could.
    //
    // A response that ends in an error frame never also carries a `[DONE]`
    // sentinel: run() calls writeDone() only on the path where the handler
    // returned normally (so "succeeded" and "failed" stay mutually exclusive
    // on the wire for the one call site in this codebase today), and this is
    // now also enforced directly by writeDone()'s own errorSent_ check above,
    // for any future caller of writeError() too.
    void writeError(const std::string& message);

    // Non-copyable, deliberately. The sseHeadersSent_/jsonResponseSent_
    // flags below are only correct while exactly one object owns them for
    // the life of the response: they record what has already gone out on a
    // socket this object does not own and cannot re-open. A copy takes a
    // snapshot and then diverges -- a handler capturing the writer by value
    // into a callback ([writer] instead of the correct [&writer]) would
    // mutate a throwaway whose flag updates never reach the real object,
    // which would then re-emit SSE headers mid-stream: silent wire
    // corruption, no exception, no failed send. Deleting these makes that
    // whole bug class a compile error at the bad capture instead. run()
    // constructs exactly one writer per streaming request in place and
    // passes it only by reference (StreamingHttpHandler takes
    // ResponseWriter&), so nothing in this codebase needs a copy.
    ResponseWriter(const ResponseWriter&) = delete;
    ResponseWriter& operator=(const ResponseWriter&) = delete;

private:
    friend class HttpServer;
    explicit ResponseWriter(intptr_t socketHandle);
    void ensureSseHeadersSent();

    intptr_t socketHandle_;
    bool sseHeadersSent_ = false;
    bool jsonResponseSent_ = false;
    bool doneSent_ = false;
    bool errorSent_ = false;
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
    // before run(). Registering the same (method, path) more than once is
    // not rejected -- the losing registration is simply never reached.
    // Within this table the first match wins. Across the two tables, it is
    // NOT registration order that decides: run() scans the
    // routeStreaming() table BEFORE this one, so a (method, path) present
    // in both is always served by the streaming handler, even if the
    // route() call came first.
    void route(const std::string& method, const std::string& path, HttpHandler handler);

    // Registers a handler that decides, per request, whether to respond
    // with one complete response (ResponseWriter::writeJsonResponse) or an
    // SSE stream (writeChunk()/writeError()). Same first-match-wins rule
    // within this table as route() has within its own; this table is the
    // one run() consults first, so a (method, path) registered in both
    // tables resolves here regardless of registration order.
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
