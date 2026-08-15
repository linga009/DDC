#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct llama_model;
struct llama_context;
struct ggml_backend_device;
typedef struct ggml_backend_device* ggml_backend_dev_t;
struct llama_model_tensor_buft_override;

namespace swarm {

// Given a draft model's proposed tokens and a target model's greedy
// predictions at those same positions, returns the accepted token
// sequence: the longest matching prefix of draft_tokens, plus exactly one
// more token from target_predictions -- either the correction at the
// first mismatch, or the bonus token if the whole draft was accepted.
//
// target_predictions must have exactly draft_tokens.size() + 1 entries:
// target_predictions[i] is the target model's prediction for the token
// immediately after draft_tokens[0..i-1] (target_predictions[0] predicts
// the token right after the existing context, before any draft token).
std::vector<int32_t> resolve_speculative_acceptance(
    const std::vector<int32_t>& draft_tokens,
    const std::vector<int32_t>& target_predictions);

// Result of a speculative-decoding completion run: the generated text, plus
// counters that let callers (and tests) observe how much the batched
// multi-token verification actually reduced round-trips to the target model.
struct SpeculativeResult {
    std::string text;
    int accepted_tokens = 0;
    int target_decode_calls = 0;
};

// Places one layer's MoE *expert* tensors (ffn_gate_exps / ffn_down_exps /
// ffn_up_exps) on the given device endpoint ("local" or one of the
// remote_endpoints passed to the InferenceEngine constructor). This does NOT
// move the whole layer: that layer's attention, norms, and router tensors
// are left wherever automatic placement puts them.
struct LayerPlacement {
    int layer;
    std::string device_endpoint;
};

class InferenceEngine {
public:
    explicit InferenceEngine(const std::string& model_path);
    InferenceEngine(const std::string& model_path, const std::vector<std::string>& remote_endpoints);
    InferenceEngine(const std::string& model_path,
                     const std::vector<std::string>& remote_endpoints,
                     const std::vector<LayerPlacement>& layer_placements);
    ~InferenceEngine();

    InferenceEngine(const InferenceEngine&) = delete;
    InferenceEngine& operator=(const InferenceEngine&) = delete;

    std::string complete(const std::string& prompt, int n_predict);

    // Speculative decoding: `draft` (a second, independent InferenceEngine)
    // proposes up to `lookahead` tokens at a time, which this engine (the
    // target) verifies in a single batched decode call against its own
    // greedy predictions, via resolve_speculative_acceptance(). Accesses
    // draft's private model_/ctx_ directly -- private members are
    // accessible between instances of the same class in C++.
    //
    // Design notes:
    //  - Deliberately redecodes the full accepted-so-far context each round
    //    (O(n^2) total work over a generation) instead of incrementally
    //    updating the KV cache across rounds -- a simplification, not an
    //    oversight; fine at test scale, not production-grade.
    //  - `draft` and `this` (the target) must share a tokenizer/vocabulary
    //    -- passing a different-family model produces silent garbage
    //    output, not an error.
    //  - This method's own tests use the *same* model for both draft and
    //    target, which proves the round-trip-reduction mechanism only, not
    //    a wall-clock speedup; a genuinely smaller/faster draft model is a
    //    drop-in swap for `draft`.
    SpeculativeResult complete_speculative(const std::string& prompt, int n_predict,
                                            InferenceEngine& draft, int lookahead);

private:
    // Backing storage for model_params.devices in the remote-device
    // constructor. llama_model stores a copy of llama_model_params
    // (including that raw pointer) for its entire lifetime, so this vector
    // must outlive model_ rather than being a constructor-local temporary.
    //
    // Declared FIRST so it is destroyed LAST: llama_model retains the raw
    // ggml_backend_dev_t* from model_params.devices for its whole lifetime,
    // so this storage must outlive model_ regardless of how model_ is freed.
    // (Today ~InferenceEngine() frees model_/ctx_ manually before member
    // destruction runs, but member order must be correct independent of
    // that -- e.g. if model_/ctx_ are ever changed to smart pointers.)
    std::vector<ggml_backend_dev_t> devices_;

    // Backing storage for model_params.tensor_buft_overrides in the
    // per-layer-placement constructor. Same lifetime requirement as
    // devices_ above: llama_model retains the raw
    // llama_model_tensor_buft_override* (and the pattern C-strings it
    // points into) for its entire lifetime, so both must outlive model_.
    // Declared before model_/ctx_ so they are destroyed after model_/ctx_
    // are, for the same reason as devices_ above. override_patterns_ must
    // be declared before tensor_overrides_ too: tensor_overrides_ entries
    // hold pointers into override_patterns_ strings, so override_patterns_
    // must be destroyed after tensor_overrides_ (reverse declaration
    // order = reverse destruction order).
    std::vector<std::string> override_patterns_;
    std::vector<llama_model_tensor_buft_override> tensor_overrides_;

    llama_model* model_ = nullptr;
    llama_context* ctx_ = nullptr;
};

}  // namespace swarm
