#include "swarm/http_server.h"
#include "swarm/inference_engine.h"
#include "swarm/json_utils.h"

#include <cstdio>
#include <cstdlib>
#include <exception>
#include <memory>
#include <stdexcept>
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

// Constant-time comparison -- a `==` on a secret-derived string is a
// timing side-channel (an attacker who can measure response latency could
// infer the token byte-by-byte from where the comparison first diverges).
bool constantTimeEquals(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) {
        return false;
    }
    unsigned char diff = 0;
    for (size_t i = 0; i < a.size(); ++i) {
        diff |= static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i]);
    }
    return diff == 0;
}

bool isAuthorized(const swarm::HttpRequest& req, const std::string& token) {
    auto it = req.headers.find("authorization");
    if (it == req.headers.end()) {
        return false;
    }
    // The scheme comparison here is case-SENSITIVE ("Bearer " only, not
    // "bearer "), which is deliberately stricter than RFC 7235, where the
    // auth-scheme token is case-insensitive. Fail-closed and identical to
    // the coordinator's isAuthorized() in coordinator/src/server.ts -- both
    // sides reject a lowercase scheme, so the two implementations can't
    // disagree about whether a given request is authorized. Not an
    // oversight.
    return constantTimeEquals(it->second, "Bearer " + token);
}

// True if `token` contains a CR/LF anywhere, or leading/trailing spaces or
// tabs. Such a token can never authenticate anyone: HTTP header parsers
// strip optional whitespace around a field value (Node's does, and this
// repo's own http_server.cpp does since Minor #12), so the value that
// arrives on the wire can never be byte-equal to a configured token that
// still carries that whitespace. Rather than authenticate nobody while
// logging a healthy startup, refuse to start. See validateAuthToken()'s
// caller for the operator-facing message.
bool hasSurroundingWhitespaceOrNewlines(const std::string& token) {
    if (token.empty()) {
        return false;  // handled by the separate empty-token check
    }
    if (token.find_first_of("\r\n") != std::string::npos) {
        return true;
    }
    return token.front() == ' ' || token.front() == '\t' ||
           token.back() == ' ' || token.back() == '\t';
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

        const char* tokenEnv = std::getenv("SWARM_AUTH_TOKEN");
        if (tokenEnv == nullptr || std::string(tokenEnv).empty()) {
            std::fprintf(stderr, "error: SWARM_AUTH_TOKEN environment variable must be set -- refusing to start unauthenticated\n");
            return 1;
        }
        std::string authToken = tokenEnv;
        // Deliberately NOT trimmed: silently rewriting the operator's secret
        // would mean the running agent authenticates against a token that
        // isn't the one they configured. Tell them instead.
        if (hasSurroundingWhitespaceOrNewlines(authToken)) {
            std::fprintf(stderr,
                         "error: SWARM_AUTH_TOKEN must not contain leading/trailing whitespace or "
                         "newlines -- check for a trailing newline from a file read "
                         "(SWARM_AUTH_TOKEN=$(cat secret.txt)) or from .env parsing. "
                         "Refusing to start with a token no client could ever match.\n");
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

        server.route("GET", "/health", [&authToken](const swarm::HttpRequest& req) {
            if (!isAuthorized(req, authToken)) {
                return swarm::HttpResponse{401, R"({"error":"missing or invalid Authorization header"})"};
            }
            return swarm::HttpResponse{200, R"({"status":"ready"})"};
        });

        // Safe: `engine` is declared before `server` in this same scope, so
        // C++'s reverse-order-of-construction destruction rule guarantees
        // `engine` outlives `server` (and therefore outlives every call this
        // handler could ever receive via server.run()'s dispatch loop) for
        // any unwind path out of this scope. In the normal case server.run()
        // below blocks forever and this scope is never unwound at all.
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

        server.run();  // blocks forever
        return 0;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "error: %s\n", e.what());
        return 1;
    }
}
