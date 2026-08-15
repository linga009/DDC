#pragma once

#include <string>
#include <vector>

struct llama_model;
struct llama_context;
struct ggml_backend_device;
typedef struct ggml_backend_device* ggml_backend_dev_t;
struct llama_model_tensor_buft_override;

namespace swarm {

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
