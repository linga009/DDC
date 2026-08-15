#include "swarm/inference_engine.h"

#include "llama.h"

#include <gtest/gtest.h>

#include <cstdio>
#include <cstdlib>
#include <regex>
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
    // Kills any swarm-rpc-server process by image/command name -- blunt, but
    // fine for a test-only fixture. Shared by SetUp() and TearDown(): see
    // their comments for why it needs to run at both ends.
    static void KillAnyRunningServer() {
#ifdef _WIN32
        std::system("taskkill /F /IM swarm-rpc-server.exe > NUL 2>&1");
#else
        std::system("pkill -f swarm-rpc-server > /dev/null 2>&1");
#endif
    }

    void SetUp() override {
        // TearDown() below only runs on normal test completion (including
        // assertion failures) -- NOT if the test binary itself aborts or
        // crashes (this codebase has real abort paths, e.g. GGML_ABORT on
        // RPC protocol errors). Clean up any server orphaned by a prior
        // crashed run before launching a new one, so the fixture is
        // self-healing instead of leaving the tree poisoned until someone
        // manually kills it. This also sidesteps a Windows quirk: the
        // vendored RPC transport sets SO_REUSEADDR, so two servers could
        // otherwise silently coexist on the same port.
        KillAnyRunningServer();

#ifdef _WIN32
        std::string cmd = "start /B \"\" \"" SWARM_RPC_SERVER_PATH "\" --port 50052 > NUL 2>&1";
#else
        std::string cmd = "\"" SWARM_RPC_SERVER_PATH "\" --port 50052 > /dev/null 2>&1 &";
#endif
        std::system(cmd.c_str());
        // give the server a moment to bind the port before tests connect
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }

    void TearDown() override {
        // The server above is launched via a detached shell ("start /B" on
        // Windows, "&" elsewhere), so we don't have its PID. Kill it by
        // image/command name instead. Without this, the leaked process keeps
        // swarm-rpc-server.exe locked on Windows and the next `cmake --build`
        // fails to relink it.
        KillAnyRunningServer();
    }
};

// RAII guard that installs a llama.cpp log callback appending into the given
// string, and restores default logging on scope exit -- including when an
// assertion (EXPECT_*/ASSERT_*) inside the guarded scope fails partway
// through, since destructors still run during stack unwinding from a
// non-fatal gtest failure (and ASSERT_* just returns, it doesn't throw).
class LlamaLogCaptureGuard {
public:
    explicit LlamaLogCaptureGuard(std::string* out) : out_(out) {
        out_->clear();
        llama_log_set(&LlamaLogCaptureGuard::Callback, out_);
    }

    ~LlamaLogCaptureGuard() {
        llama_log_set(nullptr, nullptr);
    }

    LlamaLogCaptureGuard(const LlamaLogCaptureGuard&) = delete;
    LlamaLogCaptureGuard& operator=(const LlamaLogCaptureGuard&) = delete;

private:
    // Tees to stderr in addition to capturing: if InferenceEngine
    // construction throws inside the guarded scope (the realistic failure
    // mode when this test breaks -- RPC server not up, endpoint
    // unreachable, etc.), the EXPECT_* that would print captured_log on
    // failure never runs. Without this, llama/ggml's diagnostic output --
    // which used to go to stderr by default -- would be silently
    // discarded instead, making such CI failures much harder to debug.
    static void Callback(ggml_log_level, const char* text, void* user_data) {
        static_cast<std::string*>(user_data)->append(text);
        std::fputs(text, stderr);
    }

    std::string* out_;
};

}  // namespace

#ifndef SWARM_MOE_TEST_MODEL_DIR
#define SWARM_MOE_TEST_MODEL_DIR "models"
#endif

namespace {

std::string moe_test_model_path() {
    return std::string(SWARM_MOE_TEST_MODEL_DIR) + "/tiny-moe.Q4_K_M.gguf";
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
    std::string captured_log;
    LlamaLogCaptureGuard log_guard(&captured_log);

    swarm::InferenceEngine engine(test_model_path(), std::vector<std::string>{"127.0.0.1:50052"});

    std::string result = engine.complete("The capital of France is", 8);

    EXPECT_FALSE(result.empty());
    // load_tensors logs "layer N assigned to device <name>" at DEBUG level
    // for every layer (see llama-model.cpp); remote RPC devices are named
    // "RPC0", "RPC1", etc. (see ggml_backend_rpc_add_server in
    // ggml-rpc.cpp). A purely-local fallback would only ever log
    // "assigned to device CPU", so finding "assigned to device RPC" proves
    // at least one layer was genuinely placed on the remote device.
    EXPECT_NE(captured_log.find("assigned to device RPC"), std::string::npos) << captured_log;
}

TEST(InferenceEngine, ThrowsIfRemoteEndpointUnreachable) {
    // Port 50099 has no server listening -- this proves the remote device is
    // genuinely required (not silently falling back to local-only) when a
    // remote-only device list is requested.
    EXPECT_THROW(
        (swarm::InferenceEngine(test_model_path(), std::vector<std::string>{"127.0.0.1:50099"})),
        std::runtime_error);
}

TEST(InferenceEngine, LoadsMoeModelWithExistingSingleDeviceConstructor) {
    swarm::InferenceEngine engine(moe_test_model_path());

    std::string result = engine.complete("Hello", 8);

    EXPECT_FALSE(result.empty());
}

TEST(InferenceEngine, ExplicitLocalPlacementProducesRealCompletion) {
    swarm::InferenceEngine engine(
        moe_test_model_path(),
        std::vector<std::string>{},
        std::vector<swarm::LayerPlacement>{
            {0, "local"}, {1, "local"}, {2, "local"},
        });

    std::string result = engine.complete("Hello", 8);

    EXPECT_FALSE(result.empty());
}

TEST(InferenceEngine, ThrowsOnUnknownLayerPlacementEndpoint) {
    // No RPC server needed: an unknown device_endpoint is rejected before the
    // model is loaded, so this is cheap to run alongside the other
    // non-fixture tests above.
    EXPECT_THROW(
        (swarm::InferenceEngine(moe_test_model_path(), std::vector<std::string>{},
                                 std::vector<swarm::LayerPlacement>{{0, "not-a-real-endpoint"}})),
        std::runtime_error);
}

TEST(InferenceEngine, SpeculativeDecodingProducesRealCompletion) {
    swarm::InferenceEngine target(test_model_path());
    swarm::InferenceEngine draft(test_model_path());

    swarm::SpeculativeResult result =
        target.complete_speculative("The capital of France is", 16, draft, 4);

    EXPECT_FALSE(result.text.empty());
    EXPECT_GT(result.accepted_tokens, 0);
}

TEST(InferenceEngine, SpeculativeDecodingReducesTargetDecodeCalls) {
    swarm::InferenceEngine target(test_model_path());
    swarm::InferenceEngine draft(test_model_path());

    swarm::SpeculativeResult result =
        target.complete_speculative("The capital of France is", 16, draft, 4);

    // One target decode call verifies up to `lookahead` tokens at once, so
    // the number of target decode calls should be well under one-per-token.
    EXPECT_LT(result.target_decode_calls, result.accepted_tokens);
}

TEST(InferenceEngine, SpeculativeDecodingBonusTokenMeansEvenLookaheadOneBatches) {
    swarm::InferenceEngine target(test_model_path());
    swarm::InferenceEngine draft(test_model_path());

    swarm::SpeculativeResult result =
        target.complete_speculative("The capital of France is", 8, draft, 1);

    // A verification round always requests lookahead+1 target predictions,
    // not just `lookahead` -- the extra position is the "bonus" token from
    // the same batch (see resolve_speculative_acceptance's contract: when
    // the whole draft is accepted, the returned sequence is the accepted
    // draft tokens PLUS one more). So even at lookahead=1, full acceptance
    // (guaranteed here by self-speculation + greedy sampling) means every
    // round nets 2 accepted tokens for 1 decode call, not 1 -- there is no
    // lookahead value that produces a strict 1-decode-call-per-token ratio.
    // n_predict=8 is chosen to divide evenly by (lookahead+1)=2, so this is
    // an exact equality, not a rounding-dependent bound.
    EXPECT_EQ(result.target_decode_calls, result.accepted_tokens / (1 + 1));
    EXPECT_EQ(result.accepted_tokens, 8);
}

TEST_F(RpcServerFixture, ExplicitRemotePlacementOverridesSpecificLayer) {
    std::string captured_log;
    LlamaLogCaptureGuard log_guard(&captured_log);

    swarm::InferenceEngine engine(
        moe_test_model_path(),
        std::vector<std::string>{"127.0.0.1:50052"},
        std::vector<swarm::LayerPlacement>{
            {3, "127.0.0.1:50052"},
        });

    std::string result = engine.complete("Hello", 8);

    EXPECT_FALSE(result.empty());
    // Require both facts on the same log line: that layer 3's expert tensor
    // was named AND that it was overridden to the RPC device. Checking these
    // as two independent find() calls (the original form of this assertion)
    // is vacuous for the first half -- "blk.3.ffn_gate_exps" also appears in
    // llama.cpp's normal "loading tensor" log line for every tensor, override
    // or not -- so only their co-occurrence on one line actually proves layer
    // 3 was overridden. Real log format: "tensor blk.3.ffn_gate_exps.weight
    // (1 MiB q4_K) buffer type overridden to RPC0[127.0.0.1:50052]".
    std::regex overridden_layer_3(R"(blk\.3\.ffn_[a-z]+_exps\.weight [^\n]*overridden to RPC0\[127\.0\.0\.1:50052\])");
    EXPECT_TRUE(std::regex_search(captured_log, overridden_layer_3)) << captured_log;

    // Negative check: layer 4 was NOT placed on the placements list, so it
    // must not have been overridden -- proving the override is specific to
    // layer 3 rather than accidentally broad (e.g. a pattern bug matching
    // every layer).
    std::regex overridden_layer_4(R"(blk\.4\.ffn_[a-z]+_exps\.weight [^\n]*overridden to)");
    EXPECT_FALSE(std::regex_search(captured_log, overridden_layer_4)) << captured_log;
}
