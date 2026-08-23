#include <gtest/gtest.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
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

constexpr const char* kTestAuthToken = "test-secret-token-1234";

void setTestAuthTokenEnv() {
#ifdef _WIN32
    _putenv_s("SWARM_AUTH_TOKEN", kTestAuthToken);
#else
    setenv("SWARM_AUTH_TOKEN", kTestAuthToken, 1);
#endif
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
        throw std::runtime_error("test client failed to connect to launcher on port " + std::to_string(port));
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

// Attempts a raw TCP connect to a port from a socket bound to the
// loopback interface -- this is still a loopback-originated connection
// (proving nothing about remote reachability), but combined with the
// live-adversarial-probing whole-branch review's separate check from a
// genuinely different host/interface, this at least proves the port is
// listening at all before the review does the real remote-refusal check.
// (Kept intentionally minimal here: a real non-loopback-source connection
// attempt needs a second machine or a routable non-loopback interface,
// which a single-machine CI/dev run can't manufacture -- see this task's
// own report and the Testing Considerations section of the design doc for
// why the whole-branch review is where the genuine remote-refusal proof
// belongs.)
bool canConnect(int port) {
    try {
        sendRawRequest(port, "GET / HTTP/1.1\r\nHost: x\r\n\r\n");
        return true;
    } catch (const std::exception&) {
        return false;
    }
}

void waitForLauncherUp(int port) {
    for (int attempt = 0; attempt < 50; ++attempt) {
        if (canConnect(port)) {
            return;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
    FAIL() << "swarm-launcher on port " << port << " did not come up within 10 seconds";
}

void killAnyRunningLauncher() {
#ifdef _WIN32
    std::system("taskkill /F /IM swarm-launcher.exe > NUL 2>&1");
    std::system("taskkill /F /IM swarm-node-agent.exe > NUL 2>&1");
#else
    std::system("pkill -f swarm-launcher > /dev/null 2>&1");
    std::system("pkill -f swarm-node-agent > /dev/null 2>&1");
#endif
}

// Counts live swarm-node-agent processes by asking the OS, not by probing
// the agent port.
//
// This exists because the obvious port-based proof does NOT work on this
// project's primary platform. HttpServer sets SO_REUSEADDR
// (core/src/http_server.cpp), and on Windows SO_REUSEADDR permits a second
// socket to bind an address a live listening socket already holds --
// unlike POSIX, where it does not (Windows needs SO_EXCLUSIVEADDRUSE for
// that). Verified for real while writing this file: two swarm-node-agent
// processes were started on one port and BOTH logged
// "ready, serving on 127.0.0.1:<port>", neither failing to bind.
//
// So "the second /pipeline call also returned 200" proves only that a new
// agent came up -- it does not prove the previous one died, and a
// reassembly test resting on that alone passes even with the launcher's
// kill-before-spawn deleted outright (confirmed by deliberately removing
// `currentAgent.reset()` and watching this test still pass). Counting
// processes is what actually discriminates the two, and it matters beyond
// tidiness: a surviving stale agent still holds a full model in RAM, and
// with two listeners on one port the OS decides which one a given
// connection reaches, so requests could be served by an agent running the
// PREVIOUS pipeline's model.
int countRunningAgents() {
    const std::string outPath = "launcher_test_agent_count.txt";
    std::remove(outPath.c_str());
#ifdef _WIN32
    std::system(("tasklist /FI \"IMAGENAME eq swarm-node-agent.exe\" > \"" + outPath + "\" 2>&1").c_str());
#else
    std::system(("pgrep -f swarm-node-agent > \"" + outPath + "\" 2>&1").c_str());
#endif
    std::ifstream in(outPath);
    std::string output((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    in.close();
    std::remove(outPath.c_str());

#ifdef _WIN32
    // tasklist prints one row per matching process (plus headers, and a
    // "No tasks are running..." line when there are none) -- count the
    // image name's own occurrences rather than lines.
    int count = 0;
    const std::string needle = "swarm-node-agent.exe";
    for (size_t pos = output.find(needle); pos != std::string::npos; pos = output.find(needle, pos + needle.size())) {
        ++count;
    }
    return count;
#else
    int count = 0;
    for (char c : output) {
        if (c == '\n') ++count;
    }
    return count;
#endif
}

class LauncherFixture : public ::testing::Test {
protected:
    static constexpr int kLauncherPort = 50110;
    static constexpr int kAgentPort = 50111;

    void SetUp() override {
        setTestAuthTokenEnv();
        killAnyRunningLauncher();

        std::string cmd;
#ifdef _WIN32
        cmd = "start /B \"\" \"" SWARM_LAUNCHER_PATH "\" --port " + std::to_string(kLauncherPort) +
              " --agent-port " + std::to_string(kAgentPort) +
              " --models-dir \"" SWARM_TEST_MODEL_DIR "\""
              " --node-agent-path \"" SWARM_NODE_AGENT_PATH "\" > NUL 2>&1";
#else
        cmd = "\"" SWARM_LAUNCHER_PATH "\" --port " + std::to_string(kLauncherPort) +
              " --agent-port " + std::to_string(kAgentPort) +
              " --models-dir \"" SWARM_TEST_MODEL_DIR "\""
              " --node-agent-path \"" SWARM_NODE_AGENT_PATH "\" > /dev/null 2>&1 &";
#endif
        std::system(cmd.c_str());
        waitForLauncherUp(kLauncherPort);
    }

    void TearDown() override {
        killAnyRunningLauncher();
    }
};

}  // namespace

TEST_F(LauncherFixture, PipelineEndpointSpawnsARealAgentThatBecomesHealthy) {
    // The test fixture's own --models-dir/SWARM_TEST_MODEL_DIR points at
    // this repo's real models/ directory, which has a real
    // tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf -- the launcher resolves
    // "tinyllama-1.1b-chat-v1.0" (with the extension stripped) against
    // "<models-dir>/tinyllama-1.1b-chat-v1.0.gguf"... NOTE: this repo's
    // real fixture file is actually named
    // "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf", so the model id this test
    // requests below is exactly that full stem (everything before the
    // trailing ".gguf"), matching the launcher's own "<models-dir>/<model>.gguf"
    // convention precisely -- not a shortened/aliased name.
    std::string body = R"({"model":"tinyllama-1.1b-chat-v1.0.Q4_K_M","remoteEndpoints":"","layerPlacements":""})";
    std::string request = "POST /pipeline HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nContent-Type: application/json\r\n\r\n" + body;
    std::string response = sendRawRequest(kLauncherPort, request);

    EXPECT_NE(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("\"status\":\"ready\""), std::string::npos);

    // Real, live proof the spawned agent is actually up and healthy on its
    // fixed --agent-port, authenticated with the real shared token -- not
    // just that the launcher claimed success.
    std::string healthResponse = sendRawRequest(
        kAgentPort,
        "GET /health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n");
    EXPECT_NE(healthResponse.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(healthResponse.find("\"status\":\"ready\""), std::string::npos);
}

TEST_F(LauncherFixture, PipelineEndpointRejectsAnUnknownModelWithAClearError) {
    std::string body = R"({"model":"nonexistent-model-nobody-has","remoteEndpoints":"","layerPlacements":""})";
    std::string request = "POST /pipeline HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nContent-Type: application/json\r\n\r\n" + body;
    std::string response = sendRawRequest(kLauncherPort, request);

    // Must NOT be 200 -- and must not have attempted to spawn anything with
    // a bad path (that failure mode is covered by the fact this returns
    // before any spawn is attempted at all, verified by this test's speed:
    // a real InferenceEngine model-load failure inside a spawned agent
    // would take real time and produce a different error shape).
    EXPECT_EQ(response.find("HTTP/1.1 200"), std::string::npos);
    EXPECT_NE(response.find("\"error\""), std::string::npos);
}

TEST_F(LauncherFixture, ReassemblingKillsThePreviousAgentBeforeSpawningTheNewOne) {
    std::string body = R"({"model":"tinyllama-1.1b-chat-v1.0.Q4_K_M","remoteEndpoints":"","layerPlacements":""})";
    std::string request = "POST /pipeline HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                           "\r\nContent-Type: application/json\r\n\r\n" + body;

    std::string firstResponse = sendRawRequest(kLauncherPort, request);
    ASSERT_NE(firstResponse.find("HTTP/1.1 200"), std::string::npos);
    ASSERT_EQ(countRunningAgents(), 1) << "one /pipeline call should leave exactly one agent running";

    // A second /pipeline call for the same launcher must succeed too --
    // proving the launcher killed its previous agent (freeing kAgentPort)
    // before spawning a fresh one, rather than failing with "port already
    // in use".
    // Sample the live agent count WHILE the second /pipeline call is in
    // flight, because the "Before" in this test's name is a claim about
    // ORDERING that no after-the-fact observation can check.
    //
    // Why the end state can't tell you: `currentAgent = std::move(spawned)`
    // destroys whatever the unique_ptr already held, so the previous agent
    // gets terminated either way -- deleting the launcher's explicit
    // kill-before-spawn only moves that termination to AFTER the new agent
    // has spawned and finished loading its model. Both orderings end with
    // exactly one agent alive, so both satisfy the survivor count below.
    // Only the peak DURING the call separates them (verified by mutation:
    // with `currentAgent.reset()` removed, this peak reads 2 and this test
    // fails; with it present, it reads 1).
    //
    // This is worth asserting rather than shrugging at: the overlap means
    // two full models resident in RAM simultaneously, on the phones and
    // laptops this project exists to pool -- and while both are bound to
    // one port, the OS picks which of them a connection reaches, so a
    // request can land on the outgoing pipeline's agent.
    std::atomic<int> peakAgents{0};
    std::atomic<bool> pollingDone{false};
    std::thread poller([&peakAgents, &pollingDone]() {
        while (!pollingDone.load()) {
            int seen = countRunningAgents();
            int previous = peakAgents.load();
            while (seen > previous && !peakAgents.compare_exchange_weak(previous, seen)) {
                // retry: another iteration raised it first
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    });

    std::string secondResponse = sendRawRequest(kLauncherPort, request);
    pollingDone.store(true);
    poller.join();

    EXPECT_NE(secondResponse.find("HTTP/1.1 200"), std::string::npos);

    // Exactly one agent must SURVIVE reassembly -- guards against leaking a
    // process on every call.
    EXPECT_EQ(countRunningAgents(), 1)
        << "reassembly must leave exactly one agent alive -- a second surviving process means the "
           "launcher never terminated the previous agent at all";

    // ...and at no instant during reassembly may two have been alive at
    // once, which is the actual kill-BEFORE-spawn guarantee.
    EXPECT_LE(peakAgents.load(), 1)
        << "two agents were alive simultaneously during reassembly (peak " << peakAgents.load()
        << ") -- the launcher spawned the new agent before terminating the previous one";

    std::string healthResponse = sendRawRequest(
        kAgentPort,
        "GET /health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n");
    EXPECT_NE(healthResponse.find("HTTP/1.1 200"), std::string::npos);
}
