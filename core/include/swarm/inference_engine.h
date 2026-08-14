#pragma once

#include <string>

struct llama_model;
struct llama_context;

namespace swarm {

class InferenceEngine {
public:
    explicit InferenceEngine(const std::string& model_path);
    ~InferenceEngine();

    InferenceEngine(const InferenceEngine&) = delete;
    InferenceEngine& operator=(const InferenceEngine&) = delete;

    std::string complete(const std::string& prompt, int n_predict);

private:
    llama_model* model_ = nullptr;
    llama_context* ctx_ = nullptr;
};

}  // namespace swarm
