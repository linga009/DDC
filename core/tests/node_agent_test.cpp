#include <gtest/gtest.h>

#include <chrono>
#include <cstdlib>
#include <string>
#include <thread>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
using socket_t = SOCKET;
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
using socket_t = int;
#endif

#ifndef SWARM_TEST_MODEL_DIR
#define SWARM_TEST_MODEL_DIR "models"
#endif

namespace {

std::string testModelPath() {
    return std::string(SWARM_TEST_MODEL_DIR) + "/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf";
}

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
#ifdef _WIN32
        closesocket(s);
#else
        close(s);
#endif
        throw std::runtime_error("test client failed to connect to node agent on port " + std::to_string(port));
    }

    send(s, rawRequest.data(), static_cast<int>(rawRequest.size()), 0);

    std::string response;
    char buf[4096];
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
    return response;
}

// Polls GET /health on `port` until it reports 200, or fails the current
// test after 20 seconds. Shared by every agent fixture in this file (single
// device and multi-node alike) so each one's "is the agent actually up"
// wait logic stays in exactly one place.
void waitForAgentHealth(int port) {
    for (int attempt = 0; attempt < 100; ++attempt) {
        try {
            std::string response = sendRawRequest(port, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
            if (response.find("HTTP/1.1 200") != std::string::npos) {
                return;
            }
        } catch (const std::exception&) {
            // not up yet -- keep polling
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
    FAIL() << "swarm-node-agent on port " << port << " did not become healthy within 20 seconds";
}

class NodeAgentFixture : public ::testing::Test {
protected:
    static constexpr int kAgentPort = 50098;

    static void KillAnyRunningAgent() {
#ifdef _WIN32
        std::system("taskkill /F /IM swarm-node-agent.exe > NUL 2>&1");
#else
        std::system("pkill -f swarm-node-agent > /dev/null 2>&1");
#endif
    }

    void SetUp() override {
        KillAnyRunningAgent();

        std::string cmd;
#ifdef _WIN32
        cmd = "start /B \"\" \"" SWARM_NODE_AGENT_PATH "\" --model \"" + testModelPath() +
              "\" --port " + std::to_string(kAgentPort) + " > NUL 2>&1";
#else
        cmd = "\"" SWARM_NODE_AGENT_PATH "\" --model \"" + testModelPath() +
              "\" --port " + std::to_string(kAgentPort) + " > /dev/null 2>&1 &";
#endif
        std::system(cmd.c_str());
        // Model load takes real time -- poll /health rather than a fixed
        // sleep, so this fixture doesn't flake on a slower machine or
        // under-sleep on a faster one.
        waitForAgentHealth(kAgentPort);
    }

    void TearDown() override {
        KillAnyRunningAgent();
    }
};

// Mirrors inference_engine_test.cpp's RpcServerFixture (spawn/kill pattern,
// SWARM_RPC_SERVER_PATH usage, cleanup style) combined with this file's own
// NodeAgentFixture (spawn the agent, poll /health) to prove the multi-node
// path works through the real swarm-node-agent process end-to-end: real
// HTTP -> real agent process -> real RPC-sharded InferenceEngine -> real
// response. This is the test the design spec
// (docs/superpowers/specs/2026-08-16-request-routing-design.md) explicitly
// calls for and Plan 3's Task 3 omitted -- single-device tests alone don't
// prove the --remote wiring actually works through the agent binary.
//
// Uses a distinct port pair (50097 agent / 50096 RPC) from both
// NodeAgentFixture's kAgentPort (50098) and inference_engine_test.cpp's
// RpcServerFixture port (50052), so these fixtures can never collide even
// if tests ever run concurrently or in the same process.
class MultiNodeAgentFixture : public ::testing::Test {
protected:
    static constexpr int kAgentPort = 50097;
    static constexpr int kRpcPort = 50096;

    static void KillAnyRunningAgent() {
#ifdef _WIN32
        std::system("taskkill /F /IM swarm-node-agent.exe > NUL 2>&1");
#else
        std::system("pkill -f swarm-node-agent > /dev/null 2>&1");
#endif
    }

    // Matches RpcServerFixture::KillAnyRunningServer in
    // inference_engine_test.cpp: blunt kill-by-image-name, safe to call at
    // both SetUp() (self-heals after a prior crashed run) and TearDown().
    static void KillAnyRunningRpcServer() {
#ifdef _WIN32
        std::system("taskkill /F /IM swarm-rpc-server.exe > NUL 2>&1");
#else
        std::system("pkill -f swarm-rpc-server > /dev/null 2>&1");
#endif
    }

    void SetUp() override {
        KillAnyRunningAgent();
        KillAnyRunningRpcServer();

        // Spawn the RPC server first -- the agent's InferenceEngine
        // construction (which happens synchronously inside its main(),
        // before it starts accepting HTTP connections at all) requires the
        // remote endpoint to already be reachable.
        std::string rpcCmd;
#ifdef _WIN32
        rpcCmd = "start /B \"\" \"" SWARM_RPC_SERVER_PATH "\" --port " + std::to_string(kRpcPort) + " > NUL 2>&1";
#else
        rpcCmd = "\"" SWARM_RPC_SERVER_PATH "\" --port " + std::to_string(kRpcPort) + " > /dev/null 2>&1 &";
#endif
        std::system(rpcCmd.c_str());
        // Give the RPC server a moment to bind its port before the agent
        // tries to connect, matching RpcServerFixture's own SetUp().
        std::this_thread::sleep_for(std::chrono::milliseconds(500));

        std::string agentCmd;
#ifdef _WIN32
        agentCmd = "start /B \"\" \"" SWARM_NODE_AGENT_PATH "\" --model \"" + testModelPath() +
                   "\" --port " + std::to_string(kAgentPort) + " --remote 127.0.0.1:" + std::to_string(kRpcPort) +
                   " > NUL 2>&1";
#else
        agentCmd = "\"" SWARM_NODE_AGENT_PATH "\" --model \"" + testModelPath() +
                   "\" --port " + std::to_string(kAgentPort) + " --remote 127.0.0.1:" + std::to_string(kRpcPort) +
                   " > /dev/null 2>&1 &";
#endif
        std::system(agentCmd.c_str());
        waitForAgentHealth(kAgentPort);
    }

    void TearDown() override {
        KillAnyRunningAgent();
        KillAnyRunningRpcServer();
    }
};

TEST_F(NodeAgentFixture, HealthEndpointReportsReady) {
    std::string response = sendRawRequest(kAgentPort, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("\"status\":\"ready\""), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointReturnsRealGeneratedText) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("\"text\":\""), std::string::npos);
    // The test model is tiny and the output isn't asserted for content
    // (matching this repo's existing InferenceEngine tests, which check
    // shape/behavior, not exact tiny-model output) -- only that real,
    // non-empty generated text came back through the full HTTP round-trip.
    size_t textStart = response.find("\"text\":\"") + 8;
    size_t textEnd = response.find('"', textStart);
    ASSERT_NE(textEnd, std::string::npos);
    EXPECT_GT(textEnd - textStart, 0u);
}

TEST_F(NodeAgentFixture, CompleteEndpointRejectsAMissingPromptWith400) {
    std::string body = R"({"n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 400"), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointRejectsAnOversizedNPredictWith400) {
    // n_predict above the agent-level cap (512) must be rejected outright,
    // not clamped and not allowed to run -- a large value against
    // InferenceEngine's fixed context size would otherwise tie up this
    // single-threaded server for minutes before ultimately failing anyway.
    // If this regresses, this test would hang for a very long time instead
    // of failing fast, which is itself a signal the cap is gone.
    std::string body = R"({"prompt":"The capital of France is","n_predict":9999})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 400"), std::string::npos);
}

TEST_F(MultiNodeAgentFixture, CompleteEndpointWorksAcrossRealRpcShardedInference) {
    // Proves the multi-node path through the *real* swarm-node-agent
    // process, not just InferenceEngine's constructor directly (that's
    // already covered by RpcServerFixture's tests in
    // inference_engine_test.cpp): real HTTP request -> real agent process
    // parsing --remote and building an RPC-sharded InferenceEngine -> real
    // generation split across this process and the spawned
    // swarm-rpc-server child -> real HTTP response.
    std::string body = R"({"prompt":"The capital of France is","n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    ASSERT_NE(response.find("HTTP/1.1 200"), std::string::npos) << response;
    size_t textStart = response.find("\"text\":\"");
    ASSERT_NE(textStart, std::string::npos) << response;
    textStart += 8;
    size_t textEnd = response.find('"', textStart);
    ASSERT_NE(textEnd, std::string::npos) << response;
    EXPECT_GT(textEnd - textStart, 0u) << response;
}

}  // namespace
