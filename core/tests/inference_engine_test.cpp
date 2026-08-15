#include "swarm/inference_engine.h"

#include <gtest/gtest.h>

#include <cstdlib>
#include <stdexcept>
#include <string>
#include <thread>
#include <chrono>
#include <vector>

#ifndef SWARM_TEST_MODEL_DIR
#define SWARM_TEST_MODEL_DIR "models"
#endif

namespace {

std::string test_model_path() {
    return std::string(SWARM_TEST_MODEL_DIR) + "/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf";
}

class RpcServerFixture : public ::testing::Test {
protected:
    void SetUp() override {
#ifdef _WIN32
        std::string cmd = "start /B \"\" \"" SWARM_RPC_SERVER_PATH "\" --port 50052 > NUL 2>&1";
#else
        std::string cmd = "\"" SWARM_RPC_SERVER_PATH "\" --port 50052 > /dev/null 2>&1 &";
#endif
        std::system(cmd.c_str());
        // give the server a moment to bind the port before tests connect
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
};

}  // namespace

TEST(InferenceEngine, ThrowsOnInvalidModelPath) {
    EXPECT_THROW(swarm::InferenceEngine engine("does/not/exist.gguf"), std::runtime_error);
}

TEST(InferenceEngine, LoadsValidModel) {
    EXPECT_NO_THROW(swarm::InferenceEngine engine(test_model_path()));
}

TEST(InferenceEngine, GeneratesNonEmptyCompletion) {
    swarm::InferenceEngine engine(test_model_path());

    std::string result = engine.complete("The capital of France is", 8);

    EXPECT_FALSE(result.empty());
}

TEST(InferenceEngine, ThrowsOnPromptExceedingBatchSize) {
    swarm::InferenceEngine engine(test_model_path());

    std::string long_prompt;
    for (int i = 0; i < 3000; ++i) {
        long_prompt += "hello ";
    }

    EXPECT_THROW(engine.complete(long_prompt, 8), std::runtime_error);
}

TEST(InferenceEngine, RepeatedCompleteCallsAreDeterministic) {
    swarm::InferenceEngine engine(test_model_path());

    std::string first = engine.complete("The capital of France is", 8);
    std::string second = engine.complete("The capital of France is", 8);

    EXPECT_EQ(first, second);
}

TEST(InferenceEngine, ManyCallsDoNotExhaustContext) {
    swarm::InferenceEngine engine(test_model_path());
    // n_ctx is 2048. Each call to complete() below tokenizes to ~6 prompt
    // tokens and generates up to 32 more, so without clearing the KV cache
    // between calls, cumulative usage grows by ~38 tokens per call and
    // would exhaust the 2048-token context (and complete() would start
    // throwing "llama_decode failed") well before this loop finishes.
    // Empirically confirmed: with the llama_memory_clear() fix reverted,
    // this loop throws at iteration 55 of 70. The fix keeps each call's
    // usage independent of prior calls, so all 70 iterations should
    // complete without throwing.
    for (int i = 0; i < 70; ++i) {
        EXPECT_NO_THROW(engine.complete("The capital of France is", 32));
    }
}

TEST_F(RpcServerFixture, SplitsAcrossLocalAndRemoteDevice) {
    swarm::InferenceEngine engine(test_model_path(), std::vector<std::string>{"127.0.0.1:50052"});

    std::string result = engine.complete("The capital of France is", 8);

    EXPECT_FALSE(result.empty());
}

TEST(InferenceEngine, ThrowsIfRemoteEndpointUnreachable) {
    // Port 50099 has no server listening -- this proves the remote device is
    // genuinely required (not silently falling back to local-only) when a
    // remote-only device list is requested.
    EXPECT_THROW(
        (swarm::InferenceEngine(test_model_path(), std::vector<std::string>{"127.0.0.1:50099"})),
        std::runtime_error);
}
