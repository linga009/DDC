#pragma once

#include <string>
#include <vector>

struct llama_model;
struct llama_context;
struct ggml_backend_device;
typedef struct ggml_backend_device* ggml_backend_dev_t;

namespace swarm {

class InferenceEngine {
public:
    explicit InferenceEngine(const std::string& model_path);
    InferenceEngine(const std::string& model_path, const std::vector<std::string>& remote_endpoints);
    ~InferenceEngine();

    InferenceEngine(const InferenceEngine&) = delete;
    InferenceEngine& operator=(const InferenceEngine&) = delete;

    std::string complete(const std::string& prompt, int n_predict);

private:
    llama_model* model_ = nullptr;
    llama_context* ctx_ = nullptr;
    // Backing storage for model_params.devices in the remote-device
    // constructor. llama_model stores a copy of llama_model_params
    // (including that raw pointer) for its entire lifetime, so this vector
    // must outlive model_ rather than being a constructor-local temporary.
    std::vector<ggml_backend_dev_t> devices_;
};

}  // namespace swarm
