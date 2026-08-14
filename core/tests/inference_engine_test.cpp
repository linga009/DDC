#include "swarm/inference_engine.h"

#include <gtest/gtest.h>

#include <stdexcept>
#include <string>

#ifndef SWARM_TEST_MODEL_DIR
#define SWARM_TEST_MODEL_DIR "models"
#endif

namespace {

std::string test_model_path() {
    return std::string(SWARM_TEST_MODEL_DIR) + "/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf";
}

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
