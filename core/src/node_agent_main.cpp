#include "swarm/http_server.h"
#include "swarm/inference_engine.h"
#include "swarm/json_utils.h"

#include <cstdio>
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

        // Safe: `engine` is declared before `server` in this same scope, so
        // C++'s reverse-order-of-construction destruction rule guarantees
        // `engine` outlives `server` (and therefore outlives every call this
        // handler could ever receive via server.run()'s dispatch loop) for
        // any unwind path out of this scope. In the normal case server.run()
        // below blocks forever and this scope is never unwound at all.
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
