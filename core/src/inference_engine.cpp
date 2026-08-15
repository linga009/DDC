#include "swarm/inference_engine.h"

#include "llama.h"

#include "ggml-backend.h"
#include "ggml-rpc.h"

#include <stdexcept>
#include <vector>

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
    ctx_params.n_batch = 2048;

    ctx_ = llama_init_from_model(model_, ctx_params);
    if (ctx_ == nullptr) {
        llama_model_free(model_);
        throw std::runtime_error("failed to create llama context for model: " + model_path);
    }
}

InferenceEngine::InferenceEngine(const std::string& model_path,
                                  const std::vector<std::string>& remote_endpoints) {
    ggml_backend_load_all();

    ggml_backend_dev_t local_cpu = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    if (local_cpu != nullptr) {
        devices_.push_back(local_cpu);
    }

    for (const auto& endpoint : remote_endpoints) {
        ggml_backend_reg_t rpc_reg = ggml_backend_rpc_add_server(endpoint.c_str());
        if (rpc_reg == nullptr) {
            throw std::runtime_error("failed to reach RPC endpoint: " + endpoint);
        }
        size_t n = ggml_backend_reg_dev_count(rpc_reg);
        for (size_t i = 0; i < n; ++i) {
            devices_.push_back(ggml_backend_reg_dev_get(rpc_reg, i));
        }
    }
    devices_.push_back(nullptr);  // NULL-terminated, per llama_model_params.devices contract

    llama_model_params model_params = llama_model_default_params();
    model_params.devices = devices_.data();
    model_ = llama_model_load_from_file(model_path.c_str(), model_params);
    if (model_ == nullptr) {
        throw std::runtime_error("failed to load model with remote devices: " + model_path);
    }

    llama_context_params ctx_params = llama_context_default_params();
    ctx_params.n_ctx = 2048;
    ctx_params.n_batch = 2048;

    ctx_ = llama_init_from_model(model_, ctx_params);
    if (ctx_ == nullptr) {
        llama_model_free(model_);
        throw std::runtime_error("failed to create llama context with remote devices for model: " + model_path);
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

std::string InferenceEngine::complete(const std::string& prompt, int n_predict) {
    llama_memory_clear(llama_get_memory(ctx_), true);

    const llama_vocab* vocab = llama_model_get_vocab(model_);

    const int n_prompt_tokens = -llama_tokenize(
        vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), nullptr, 0, true, true);

    std::vector<llama_token> prompt_tokens(n_prompt_tokens);
    if (llama_tokenize(
            vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()),
            prompt_tokens.data(), static_cast<int32_t>(prompt_tokens.size()),
            true, true) < 0) {
        throw std::runtime_error("failed to tokenize prompt");
    }

    if (prompt_tokens.size() > static_cast<size_t>(llama_n_batch(ctx_))) {
        throw std::runtime_error("prompt too long: " + std::to_string(prompt_tokens.size()) +
                                 " tokens exceeds batch size " + std::to_string(llama_n_batch(ctx_)));
    }

    llama_sampler_chain_params sampler_params = llama_sampler_chain_default_params();
    llama_sampler* sampler = llama_sampler_chain_init(sampler_params);
    llama_sampler_chain_add(sampler, llama_sampler_init_greedy());

    llama_batch batch = llama_batch_get_one(
        prompt_tokens.data(), static_cast<int32_t>(prompt_tokens.size()));

    std::string result;
    llama_token new_token;
    int n_generated = 0;

    while (n_generated < n_predict) {
        if (llama_decode(ctx_, batch) != 0) {
            llama_sampler_free(sampler);
            throw std::runtime_error("llama_decode failed");
        }

        new_token = llama_sampler_sample(sampler, ctx_, -1);
        if (llama_vocab_is_eog(vocab, new_token)) {
            break;
        }

        char piece[128];
        int n = llama_token_to_piece(vocab, new_token, piece, sizeof(piece), 0, true);
        if (n < 0) {
            llama_sampler_free(sampler);
            throw std::runtime_error("failed to convert token to text");
        }
        result.append(piece, n);

        batch = llama_batch_get_one(&new_token, 1);
        n_generated += 1;
    }

    llama_sampler_free(sampler);
    return result;
}

}  // namespace swarm
