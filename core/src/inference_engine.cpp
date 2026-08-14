#include "swarm/inference_engine.h"

#include "llama.h"

#include <stdexcept>

namespace swarm {

InferenceEngine::InferenceEngine(const std::string& model_path) {
    ggml_backend_load_all();

    llama_model_params model_params = llama_model_default_params();
    model_ = llama_model_load_from_file(model_path.c_str(), model_params);
    if (model_ == nullptr) {
        throw std::runtime_error("failed to load model: " + model_path);
    }

    llama_context_params ctx_params = llama_context_default_params();
    ctx_params.n_ctx = 2048;
    ctx_params.n_batch = 512;

    ctx_ = llama_init_from_model(model_, ctx_params);
    if (ctx_ == nullptr) {
        llama_model_free(model_);
        throw std::runtime_error("failed to create llama context for model: " + model_path);
    }
}

InferenceEngine::~InferenceEngine() {
    if (ctx_ != nullptr) {
        llama_free(ctx_);
    }
    if (model_ != nullptr) {
        llama_model_free(model_);
    }
}

std::string InferenceEngine::complete(const std::string& /*prompt*/, int /*n_predict*/) {
    throw std::runtime_error("not implemented yet");
}

}  // namespace swarm
