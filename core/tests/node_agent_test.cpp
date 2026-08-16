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
        waitForHealth();
    }

    void TearDown() override {
        KillAnyRunningAgent();
    }

    void waitForHealth() {
        for (int attempt = 0; attempt < 100; ++attempt) {
            try {
                std::string response = sendRawRequest(kAgentPort, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
                if (response.find("HTTP/1.1 200") != std::string::npos) {
                    return;
                }
            } catch (const std::exception&) {
                // not up yet -- keep polling
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }
        FAIL() << "swarm-node-agent did not become healthy within 20 seconds";
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

}  // namespace
