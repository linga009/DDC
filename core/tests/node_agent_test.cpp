#include <gtest/gtest.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
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

constexpr const char* kTestAuthToken = "test-secret-token-1234";

void setTestAuthTokenEnv() {
#ifdef _WIN32
    _putenv_s("SWARM_AUTH_TOKEN", kTestAuthToken);
#else
    setenv("SWARM_AUTH_TOKEN", kTestAuthToken, 1);
#endif
}

// Sets SWARM_AUTH_TOKEN in THIS process's environment to an arbitrary
// (possibly malformed) value. std::system() spawns through the C runtime and
// the child inherits this process's environment, so whatever is set here is
// exactly what the spawned agent binary reads from getenv().
void setAuthTokenEnvRaw(const char* value) {
#ifdef _WIN32
    _putenv_s("SWARM_AUTH_TOKEN", value);
#else
    setenv("SWARM_AUTH_TOKEN", value, 1);
#endif
}

void unsetAuthTokenEnv() {
#ifdef _WIN32
    // On the UCRT, _putenv_s with an empty value removes the variable
    // entirely -- which is what "unset" must mean here, since the agent
    // treats set-but-empty and unset with the same branch anyway.
    _putenv_s("SWARM_AUTH_TOKEN", "");
#else
    unsetenv("SWARM_AUTH_TOKEN");
#endif
}

// Restores the valid shared test token on scope exit, so a failing
// assertion can never leave a broken SWARM_AUTH_TOKEN behind for whichever
// test GoogleTest runs next in this shared binary.
struct AuthTokenEnvGuard {
    ~AuthTokenEnvGuard() { setTestAuthTokenEnv(); }
};

// Spawns the real swarm-node-agent binary in the FOREGROUND (unlike the
// fixtures below, which spawn it detached and poll /health) and returns its
// exit code, with everything it wrote to stdout/stderr captured in `output`.
//
// Only valid for cases where the agent is expected to refuse to start: the
// model path passed is deliberately nonexistent, so if a regression ever
// lets startup past the SWARM_AUTH_TOKEN checks, this call fails fast at
// model load (with a different message, which the assertions catch) instead
// of loading a real model and blocking forever on server.run().
int runAgentExpectingRefusalToStart(int port, std::string& output) {
    const std::string outPath = "node_agent_startup_test_output.txt";
    std::remove(outPath.c_str());

    std::string cmd = "\"" SWARM_NODE_AGENT_PATH "\" --model \"no-such-model-file.gguf\" --port " +
                      std::to_string(port) + " > \"" + outPath + "\" 2>&1";
#ifdef _WIN32
    // std::system() runs this through `cmd /c`, which strips the first and
    // last quote character off a command that begins with one -- turning the
    // quoted exe path into a mangled single token ("...agent.exe" --model
    // ... .txt) that cmd then reports as an unrecognized command. Wrapping
    // the WHOLE command in one more pair of quotes gives cmd that outer pair
    // to eat and leaves the real quoting intact. (Caught for real: without
    // this, the spawn "failed" with a non-zero exit for the wrong reason,
    // which is why these tests assert on the message and not just the code.)
    cmd = "\"" + cmd + "\"";
#endif
    int rc = std::system(cmd.c_str());

    std::ifstream in(outPath);
    output.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    in.close();
    std::remove(outPath.c_str());
    return rc;
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
            std::string response = sendRawRequest(
                port,
                "GET /health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n");
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
        setTestAuthTokenEnv();
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
        setTestAuthTokenEnv();
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
    std::string response = sendRawRequest(
        kAgentPort,
        "GET /health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n");
    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("\"status\":\"ready\""), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointReturnsRealGeneratedText) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
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

TEST_F(NodeAgentFixture, CompleteEndpointStreamsRealTokensAsSeparateSseFrames) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8,"stream":true})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;

    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("Content-Type: text/event-stream"), std::string::npos);
    // At least one real "data: " frame must have arrived -- the test model
    // and n_predict=8 keep this fast, and shape (not exact tiny-model
    // output) is what's asserted, matching this repo's existing convention.
    EXPECT_NE(response.find("data: "), std::string::npos);
    // The real end-to-end wire format ends with the same terminal sentinel
    // OpenAI-compatible streaming APIs use, and it is the LAST thing on the
    // wire -- this is what lets a client tell "the generation finished" apart
    // from "the connection died mid-stream", which a bare socket close
    // cannot express. A successful stream also carries no error frame.
    size_t done = response.find("data: [DONE]\n\n");
    ASSERT_NE(done, std::string::npos);
    EXPECT_EQ(done + std::strlen("data: [DONE]\n\n"), response.size());
    EXPECT_EQ(response.find("event: error"), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointWithoutStreamFieldBehavesExactlyAsBefore) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;

    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("Content-Type: application/json"), std::string::npos);
    EXPECT_NE(response.find("\"text\":\""), std::string::npos);
    EXPECT_EQ(response.find("text/event-stream"), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointNonStreamingResponseIncludesRealTokenCounts) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("\"prompt_tokens\":"), std::string::npos);
    EXPECT_NE(response.find("\"completion_tokens\":"), std::string::npos);
    // finish_reason must be present and be one of exactly two valid values --
    // the precise boundary logic (reachedLimit vs completionTokens) is
    // already proven at the InferenceEngine unit level (Task 1); this test
    // only proves the JSON WIRING is correct, not the boundary condition
    // itself.
    bool hasStop = response.find("\"finish_reason\":\"stop\"") != std::string::npos;
    bool hasLength = response.find("\"finish_reason\":\"length\"") != std::string::npos;
    EXPECT_TRUE(hasStop || hasLength);
    // This is included REGARDLESS of any includeUsage field -- confirmed by
    // omitting it entirely from this request's body above.
}

TEST_F(NodeAgentFixture, CompleteEndpointStreamingWithIncludeUsageSendsUsageFrameBeforeDone) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8,"stream":true,"includeUsage":true})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    size_t usagePos = response.find("event: usage");
    size_t donePos = response.find("data: [DONE]");
    ASSERT_NE(usagePos, std::string::npos);
    ASSERT_NE(donePos, std::string::npos);
    EXPECT_LT(usagePos, donePos);
    EXPECT_NE(response.find("\"prompt_tokens\":"), std::string::npos);
    EXPECT_NE(response.find("\"completion_tokens\":"), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointStreamingWithoutIncludeUsageOmitsUsageFrame) {
    // Regression test: the existing streaming wire format (Phase D, already
    // shipped and consumed by SwarmClient/the dashboard) must be
    // byte-for-byte unaffected when includeUsage is absent.
    std::string body = R"({"prompt":"The capital of France is","n_predict":8,"stream":true})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_EQ(response.find("event: usage"), std::string::npos);
    size_t done = response.find("data: [DONE]\n\n");
    ASSERT_NE(done, std::string::npos);
    EXPECT_EQ(done + std::strlen("data: [DONE]\n\n"), response.size());
}

TEST_F(NodeAgentFixture, CompleteEndpointStreamingWithIncludeUsageFalseOmitsUsageFrame) {
    // Same regression guarantee as above, but with includeUsage EXPLICITLY
    // false rather than merely absent -- both must behave identically.
    std::string body = R"({"prompt":"The capital of France is","n_predict":8,"stream":true,"includeUsage":false})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_EQ(response.find("event: usage"), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointNonStreamingWithIncludeUsageFieldStillJustReturnsJson) {
    // includeUsage only has meaning for the streaming path -- a non-streaming
    // request that happens to set it must still get the same plain JSON
    // response (with counts, per the first test above), not an SSE stream.
    std::string body = R"({"prompt":"The capital of France is","n_predict":8,"includeUsage":true})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("Content-Type: application/json"), std::string::npos);
    EXPECT_EQ(response.find("text/event-stream"), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointRejectsAMissingPromptWith400) {
    std::string body = R"({"n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
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
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 400"), std::string::npos);
}

TEST_F(NodeAgentFixture, HealthEndpointRejectsMissingAuthWith401) {
    std::string response = sendRawRequest(kAgentPort, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
    EXPECT_NE(response.find("HTTP/1.1 401"), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointRejectsMissingAuthWith401) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 401"), std::string::npos);
}

TEST_F(NodeAgentFixture, CompleteEndpointRejectsWrongAuthWith401) {
    std::string body = R"({"prompt":"The capital of France is","n_predict":8})";
    std::string request = "POST /complete HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nAuthorization: Bearer wrong-token\r\n\r\n" + body;
    std::string response = sendRawRequest(kAgentPort, request);

    EXPECT_NE(response.find("HTTP/1.1 401"), std::string::npos);
}

// These three spawn the agent binary directly rather than going through
// NodeAgentFixture: the whole point is a process that never becomes
// healthy, so the fixture's spawn-detached-and-poll-/health machinery is
// exactly the wrong shape. A distinct port (50094) from every fixture in
// this file keeps them from ever colliding, though nothing should bind it.
TEST(NodeAgentStartupTest, RefusesToStartWhenAuthTokenIsUnset) {
    AuthTokenEnvGuard restoreTokenForLaterTests;
    unsetAuthTokenEnv();

    std::string output;
    int rc = runAgentExpectingRefusalToStart(50094, output);

    EXPECT_NE(rc, 0) << output;
    // Assert on the message, not just the exit code: a nonexistent model
    // path also exits non-zero, so the exit code alone would still "pass"
    // if the token check were deleted outright.
    EXPECT_NE(output.find("SWARM_AUTH_TOKEN"), std::string::npos) << output;
}

TEST(NodeAgentStartupTest, RefusesToStartWhenAuthTokenHasATrailingNewline) {
    // The single most likely real-world misconfiguration:
    // SWARM_AUTH_TOKEN=$(cat secret.txt) where the file ends in a newline,
    // or a .env line with a stray trailing space. Every HTTP header parser
    // (Node's, and this repo's own since Minor #12) strips whitespace around
    // a received field value, so a token that still carries it can never be
    // matched -- the agent would come up "healthy" and then 401 literally
    // every request, including one sending the byte-exact configured token.
    AuthTokenEnvGuard restoreTokenForLaterTests;
    setAuthTokenEnvRaw("tok-with-trailing-newline\n");

    std::string output;
    int rc = runAgentExpectingRefusalToStart(50094, output);

    EXPECT_NE(rc, 0) << output;
    EXPECT_NE(output.find("SWARM_AUTH_TOKEN"), std::string::npos) << output;
}

TEST(NodeAgentStartupTest, RefusesToStartWhenAuthTokenHasALeadingSpace) {
    AuthTokenEnvGuard restoreTokenForLaterTests;
    setAuthTokenEnvRaw(" tok-with-leading-space");

    std::string output;
    int rc = runAgentExpectingRefusalToStart(50094, output);

    EXPECT_NE(rc, 0) << output;
    EXPECT_NE(output.find("SWARM_AUTH_TOKEN"), std::string::npos) << output;
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
                           "\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n" + body;
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
