#include "swarm/http_server.h"
#include "swarm/json_utils.h"
#include "swarm/spawned_process.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
using socket_t = SOCKET;
#else
#include <arpa/inet.h>
#include <cerrno>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
using socket_t = int;
#endif

namespace {

// Splits `s` on `,`, dropping empty segments (so "" -> {} and "a,,b" -> {"a","b"}
// -- an accidental double-comma or a trailing one from client-side string
// building shouldn't produce a bogus empty --remote/--layer-placement value).
std::vector<std::string> splitCommaSeparated(const std::string& s) {
    std::vector<std::string> parts;
    std::stringstream ss(s);
    std::string part;
    while (std::getline(ss, part, ',')) {
        if (!part.empty()) {
            parts.push_back(part);
        }
    }
    return parts;
}

bool fileExists(const std::string& path) {
    std::ifstream f(path);
    return f.good();
}

// True if `model` contains any character/sequence that could let it escape
// the operator-configured --models-dir when concatenated into
// "<modelsDir>/<model>.gguf" below: a path separator (either slash --
// forward for POSIX-style traversal, backward for Windows-style), a colon
// (Windows drive-letter absolute paths like "C:\..." and NTFS
// alternate-data-stream syntax like "file.gguf:hidden"), or a literal ".."
// (parent-directory traversal). Every real model id in this project's
// actual catalog/fixtures (e.g. "tinyllama-1.1b-chat-v1.0.Q4_K_M") is just
// letters, digits, single dots, hyphens, and underscores, so this cannot
// reject a legitimate model id.
bool containsPathTraversalChars(const std::string& model) {
    return model.find('/') != std::string::npos || model.find('\\') != std::string::npos ||
           model.find(':') != std::string::npos || model.find("..") != std::string::npos;
}

// True if `token` contains a CR/LF anywhere, or leading/trailing spaces or
// tabs -- identical check to swarm-node-agent's own (core/src/node_agent_main.cpp),
// duplicated here rather than shared, matching this project's existing
// precedent of small per-binary validation helpers (see that file's own
// comment on why this repo doesn't factor this into a shared utility).
bool hasSurroundingWhitespaceOrNewlines(const std::string& token) {
    if (token.empty()) {
        return false;
    }
    if (token.find_first_of("\r\n") != std::string::npos) {
        return true;
    }
    return token.front() == ' ' || token.front() == '\t' ||
           token.back() == ' ' || token.back() == '\t';
}

// Raw-socket HTTP GET, used only to poll a just-spawned agent's own
// /health -- this is production code's own copy of the same technique
// this project's test fixtures already use (e.g.
// core/tests/node_agent_test.cpp's sendRawRequest/waitForAgentHealth),
// reimplemented here since those are test-only helpers, not exported
// production utilities.
bool pollHealthOnce(int port, const std::string& authToken) {
#ifdef _WIN32
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);
#endif
    socket_t s = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(static_cast<uint16_t>(port));

    // Bound the connect() itself to a short, fixed timeout instead of
    // trusting the OS's own connection-refused detection: live-measured on
    // this project's actual Windows/MSYS2 target platform, a blocking
    // connect() to a port nothing is listening on (the exact case that
    // matters here -- an unhealthy or crashed spawn) takes ~2.2s to fail,
    // not the near-instant failure the surrounding waitForAgentHealthy()'s
    // 500ms-sleep-per-attempt design assumes. Left unbounded, 60 poll
    // attempts * ~2.2s each pushed the real unhealthy-spawn detection
    // ceiling to ~2m42s despite the intended ~30s one -- and because this
    // launcher's HttpServer is single-threaded, the entire launcher is
    // unresponsive to any other POST /pipeline request for that whole
    // window, not just the one failing request.
    //
    // Standard technique for a bounded-timeout connect on a blocking socket:
    // switch to non-blocking mode, attempt connect() (which for an
    // in-progress TCP handshake returns immediately with
    // EWOULDBLOCK/EINPROGRESS rather than blocking), then select() on the
    // write-set with a short timeout to wait for either completion or the
    // deadline. select() returning writable does NOT by itself mean the
    // connection succeeded -- SO_ERROR via getsockopt() afterward is what
    // actually distinguishes "connected" from "refused."
#ifdef _WIN32
    u_long nonBlockingMode = 1;
    ioctlsocket(s, FIONBIO, &nonBlockingMode);
#else
    int originalFlags = fcntl(s, F_GETFL, 0);
    fcntl(s, F_SETFL, originalFlags | O_NONBLOCK);
#endif

    int connectResult = connect(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
    bool connected = (connectResult == 0);  // rare, but a loopback connect can complete synchronously
    if (!connected) {
#ifdef _WIN32
        bool inProgress = (WSAGetLastError() == WSAEWOULDBLOCK);
#else
        bool inProgress = (errno == EINPROGRESS);
#endif
        if (inProgress) {
            fd_set writeSet;
            FD_ZERO(&writeSet);
            FD_SET(s, &writeSet);
            timeval timeout{};
            // 250ms, not the naive-seeming 1s: live-measured, a 1s bound
            // still yielded a ~91s worst-case ceiling (60 * (1s + 500ms
            // sleep)), because this platform's true refusal-detection delay
            // (~2.2s) exceeds even a full 1s budget, so EVERY unhealthy
            // attempt was consuming the entire timeout rather than
            // returning early. 250ms keeps the same ceiling math down near
            // the originally-intended ~30-45s window (60 * (250ms + 500ms)
            // = 45s) while staying enormously generous for the healthy
            // path, where a real listening loopback socket completes the
            // TCP handshake in low single-digit milliseconds, not hundreds.
            timeout.tv_sec = 0;
            timeout.tv_usec = 250000;
#ifdef _WIN32
            // Windows' select() ignores its first argument entirely (unlike
            // POSIX, where it must be the highest fd + 1) -- 0 is the
            // conventional value to pass here.
            int selectResult = select(0, nullptr, &writeSet, nullptr, &timeout);
#else
            int selectResult = select(s + 1, nullptr, &writeSet, nullptr, &timeout);
#endif
            if (selectResult > 0 && FD_ISSET(s, &writeSet)) {
                int soError = 0;
                socklen_t soErrorLen = sizeof(soError);
                if (getsockopt(s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&soError), &soErrorLen) == 0 &&
                    soError == 0) {
                    connected = true;
                }
            }
            // selectResult <= 0 (timeout or select() error) or a non-zero
            // SO_ERROR both mean "not connected" -- `connected` stays false.
        }
        // Any other connect() failure (e.g. a synchronous refusal some
        // platforms can return immediately even in non-blocking mode) also
        // just means "not connected" -- `connected` stays false.
    }

    if (!connected) {
#ifdef _WIN32
        closesocket(s);
#else
        close(s);
#endif
        return false;
    }

    // Restore blocking mode -- the rest of this function does a plain
    // blocking send()/recv() round-trip against a now-established
    // connection, unchanged from before this fix.
#ifdef _WIN32
    u_long blockingMode = 0;
    ioctlsocket(s, FIONBIO, &blockingMode);
#else
    fcntl(s, F_SETFL, originalFlags);
#endif

    std::string request = "GET /health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + authToken + "\r\n\r\n";
    send(s, request.data(), static_cast<int>(request.size()), 0);
    std::string response;
    char buf[512];
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
    return response.find("HTTP/1.1 200") != std::string::npos;
}

bool waitForAgentHealthy(int port, const std::string& authToken, int maxAttempts, int sleepMs) {
    for (int attempt = 0; attempt < maxAttempts; ++attempt) {
        if (pollHealthOnce(port, authToken)) {
            return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(sleepMs));
    }
    return false;
}

}  // namespace

int main(int argc, char** argv) {
    int launcherPort = 0;
    int agentPort = 0;
    std::string modelsDir;
    std::string nodeAgentPath;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc) {
            launcherPort = std::stoi(argv[++i]);
        } else if (arg == "--agent-port" && i + 1 < argc) {
            agentPort = std::stoi(argv[++i]);
        } else if (arg == "--models-dir" && i + 1 < argc) {
            modelsDir = argv[++i];
        } else if (arg == "--node-agent-path" && i + 1 < argc) {
            nodeAgentPath = argv[++i];
        } else {
            std::fprintf(stderr, "unrecognized argument: %s\n", arg.c_str());
            return 1;
        }
    }

    if (launcherPort <= 0 || agentPort <= 0 || modelsDir.empty() || nodeAgentPath.empty()) {
        std::fprintf(stderr,
                     "usage: %s --port N --agent-port N --models-dir <dir> --node-agent-path <path>\n",
                     argv[0]);
        return 1;
    }

    const char* tokenEnv = std::getenv("SWARM_AUTH_TOKEN");
    if (tokenEnv == nullptr || std::string(tokenEnv).empty()) {
        std::fprintf(stderr, "error: SWARM_AUTH_TOKEN environment variable must be set -- refusing to start\n");
        return 1;
    }
    std::string authToken = tokenEnv;
    if (hasSurroundingWhitespaceOrNewlines(authToken)) {
        std::fprintf(stderr,
                     "error: SWARM_AUTH_TOKEN must not contain leading/trailing whitespace or newlines -- "
                     "refusing to start with a token no agent's /health could ever match.\n");
        return 1;
    }

    std::printf("swarm-launcher: ready, serving on 127.0.0.1:%d (spawned agents will listen on port %d)\n",
                launcherPort, agentPort);
    std::fflush(stdout);

    // Owns the currently-spawned agent, if any -- replaced (destroying,
    // and therefore terminating, the previous one) on every /pipeline
    // call. Captured by reference into the route handler below; this
    // local outlives the server exactly like swarm-node-agent's own
    // `engine` local outlives its server (see that file's own comment on
    // why declaration order here guarantees this).
    std::unique_ptr<swarm::SpawnedProcess> currentAgent;

    // HttpServer binds to 127.0.0.1 only (core/src/http_server.cpp) --
    // this is the ENTIRE localhost-only trust mechanism for this binary.
    // No auth-header check is added to this route: reachability itself is
    // the trust boundary, by explicit design (see this plan's Global
    // Constraints and the design doc's Architecture #2). Do not add one.
    swarm::HttpServer server(launcherPort);

    server.route("POST", "/pipeline", [&](const swarm::HttpRequest& req) -> swarm::HttpResponse {
        std::string model;
        if (!swarm::extractJsonString(req.body, "model", model) || model.empty()) {
            return swarm::HttpResponse{400, R"({"error":"model must be a non-empty JSON string field"})"};
        }
        if (containsPathTraversalChars(model)) {
            return swarm::HttpResponse{
                400, R"({"error":"model must not contain '/', '\\', ':', or '..' -- path traversal is not allowed"})"};
        }
        std::string remoteEndpointsRaw;
        swarm::extractJsonString(req.body, "remoteEndpoints", remoteEndpointsRaw);  // optional -- "" if absent
        std::string layerPlacementsRaw;
        swarm::extractJsonString(req.body, "layerPlacements", layerPlacementsRaw);  // optional -- "" if absent

        std::string modelFile = modelsDir + "/" + model + ".gguf";
        if (!fileExists(modelFile)) {
            return swarm::HttpResponse{404, R"({"error":"no model file found for \")" + swarm::jsonEscapeString(model) +
                                             R"(\" under this launcher's --models-dir"})"};
        }

        std::vector<std::string> agentArgv = {nodeAgentPath, "--model", modelFile, "--port", std::to_string(agentPort)};
        for (const auto& endpoint : splitCommaSeparated(remoteEndpointsRaw)) {
            agentArgv.push_back("--remote");
            agentArgv.push_back(endpoint);
        }
        for (const auto& placement : splitCommaSeparated(layerPlacementsRaw)) {
            agentArgv.push_back("--layer-placement");
            agentArgv.push_back(placement);
        }

        // Destroying the previous SpawnedProcess (if any) terminates it --
        // this is what makes reassembly free the port the new agent needs,
        // BEFORE the new one is spawned.
        currentAgent.reset();
        std::unique_ptr<swarm::SpawnedProcess> spawned;
        try {
            spawned = std::make_unique<swarm::SpawnedProcess>(agentArgv);
        } catch (const std::exception& e) {
            return swarm::HttpResponse{500, R"({"error":"failed to spawn swarm-node-agent: )" +
                                             swarm::jsonEscapeString(e.what()) + R"("})"};
        }

        // Real model loads can take real time (observed: low seconds for a
        // small model on this dev machine, more for larger ones) -- 60
        // attempts * 500ms = 30s ceiling before giving up.
        if (!waitForAgentHealthy(agentPort, authToken, /*maxAttempts=*/60, /*sleepMs=*/500)) {
            spawned.reset();  // don't leave a never-became-healthy process running
            return swarm::HttpResponse{500, R"({"error":"spawned swarm-node-agent did not become healthy in time"})"};
        }

        currentAgent = std::move(spawned);
        return swarm::HttpResponse{200, R"({"status":"ready"})"};
    });

    server.run();  // blocks forever
    return 0;
}
