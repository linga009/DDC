#include "swarm/inference_engine.h"

#include "llama.h"

#include "ggml-backend.h"
#include "ggml-rpc.h"

#include <algorithm>
#include <stdexcept>
#include <unordered_map>
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

InferenceEngine::InferenceEngine(const std::string& model_path,
                                  const std::vector<std::string>& remote_endpoints,
                                  const std::vector<LayerPlacement>& layer_placements) {
    ggml_backend_load_all();

    devices_.clear();
    ggml_backend_dev_t local_cpu = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    if (local_cpu != nullptr) {
        devices_.push_back(local_cpu);
    }

    // endpoint string -> resolved buffer type, so multiple layers naming the
    // same remote endpoint reuse one RPC connection instead of opening a new
    // one per layer.
    std::unordered_map<std::string, ggml_backend_buffer_type_t> endpoint_buft;
    if (local_cpu == nullptr) {
        throw std::runtime_error("no local CPU backend device available");
    }
    endpoint_buft["local"] = ggml_backend_dev_buffer_type(local_cpu);

    for (const auto& endpoint : remote_endpoints) {
        ggml_backend_reg_t rpc_reg = ggml_backend_rpc_add_server(endpoint.c_str());
        if (rpc_reg == nullptr) {
            throw std::runtime_error("failed to reach RPC endpoint: " + endpoint);
        }
        size_t n = ggml_backend_reg_dev_count(rpc_reg);
        for (size_t i = 0; i < n; ++i) {
            ggml_backend_dev_t dev = ggml_backend_reg_dev_get(rpc_reg, i);
            devices_.push_back(dev);
        }
        if (n > 0) {
            ggml_backend_buffer_type_t rpc_buft = ggml_backend_dev_buffer_type(ggml_backend_reg_dev_get(rpc_reg, 0));
            if (rpc_buft == nullptr) {
                throw std::runtime_error("failed to resolve buffer type for RPC endpoint: " + endpoint);
            }
            endpoint_buft[endpoint] = rpc_buft;
        }
    }
    devices_.push_back(nullptr);

    override_patterns_.reserve(layer_placements.size());
    tensor_overrides_.reserve(layer_placements.size() + 1);
    for (const auto& placement : layer_placements) {
        auto it = endpoint_buft.find(placement.device_endpoint);
        if (it == endpoint_buft.end()) {
            throw std::runtime_error(
                "layer placement references unknown device endpoint: " + placement.device_endpoint);
        }
        override_patterns_.push_back("^blk\\." + std::to_string(placement.layer) + "\\.ffn_.*_exps");
        tensor_overrides_.push_back({override_patterns_.back().c_str(), it->second});
    }
    tensor_overrides_.push_back({nullptr, nullptr});

    llama_model_params model_params = llama_model_default_params();
    model_params.devices = devices_.data();
    model_params.tensor_buft_overrides = tensor_overrides_.data();
    model_ = llama_model_load_from_file(model_path.c_str(), model_params);
    if (model_ == nullptr) {
        throw std::runtime_error("failed to load model with layer placements: " + model_path);
    }

    llama_context_params ctx_params = llama_context_default_params();
    ctx_params.n_ctx = 2048;
    ctx_params.n_batch = 2048;

    ctx_ = llama_init_from_model(model_, ctx_params);
    if (ctx_ == nullptr) {
        llama_model_free(model_);
        throw std::runtime_error("failed to create llama context with layer placements for model: " + model_path);
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

SpeculativeResult InferenceEngine::complete_speculative(
    const std::string& prompt, int n_predict, InferenceEngine& draft, int lookahead) {
    const llama_vocab* vocab = llama_model_get_vocab(model_);

    const int n_prompt_tokens = -llama_tokenize(
        vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()), nullptr, 0, true, true);
    std::vector<llama_token> tokens_so_far(n_prompt_tokens);
    if (llama_tokenize(vocab, prompt.c_str(), static_cast<int32_t>(prompt.size()),
                        tokens_so_far.data(), static_cast<int32_t>(tokens_so_far.size()),
                        true, true) < 0) {
        throw std::runtime_error("failed to tokenize prompt");
    }

    llama_sampler* target_sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(target_sampler, llama_sampler_init_greedy());

    SpeculativeResult result;

    while (result.accepted_tokens < n_predict) {
        const int lookahead_n = std::min(lookahead, n_predict - result.accepted_tokens);

        // --- Draft: clear, redecode tokens_so_far, then step lookahead_n tokens.
        llama_memory_clear(llama_get_memory(draft.ctx_), true);
        {
            llama_batch draft_prompt_batch = llama_batch_get_one(
                tokens_so_far.data(), static_cast<int32_t>(tokens_so_far.size()));
            if (llama_decode(draft.ctx_, draft_prompt_batch) != 0) {
                llama_sampler_free(target_sampler);
                throw std::runtime_error("draft decode of context failed");
            }
        }
        llama_sampler* draft_sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
        llama_sampler_chain_add(draft_sampler, llama_sampler_init_greedy());

        std::vector<llama_token> draft_tokens;
        draft_tokens.reserve(lookahead_n);
        for (int i = 0; i < lookahead_n; ++i) {
            llama_token next = llama_sampler_sample(draft_sampler, draft.ctx_, -1);
            draft_tokens.push_back(next);
            llama_batch step = llama_batch_get_one(&draft_tokens.back(), 1);
            if (llama_decode(draft.ctx_, step) != 0) {
                llama_sampler_free(draft_sampler);
                llama_sampler_free(target_sampler);
                throw std::runtime_error("draft decode of speculative token failed");
            }
        }
        llama_sampler_free(draft_sampler);

        // --- Target: clear, decode tokens_so_far + draft_tokens as ONE batch
        //     with logits requested at every position -- this single call is
        //     the round-trip reduction.
        llama_memory_clear(llama_get_memory(ctx_), true);
        const int32_t n_verify = static_cast<int32_t>(tokens_so_far.size() + draft_tokens.size());
        llama_batch verify_batch = llama_batch_init(n_verify, 0, 1);
        for (size_t i = 0; i < tokens_so_far.size(); ++i) {
            verify_batch.token[verify_batch.n_tokens]    = tokens_so_far[i];
            verify_batch.pos[verify_batch.n_tokens]      = static_cast<llama_pos>(i);
            verify_batch.n_seq_id[verify_batch.n_tokens] = 1;
            verify_batch.seq_id[verify_batch.n_tokens][0] = 0;
            verify_batch.logits[verify_batch.n_tokens]   = true;
            verify_batch.n_tokens++;
        }
        for (size_t i = 0; i < draft_tokens.size(); ++i) {
            const size_t pos = tokens_so_far.size() + i;
            verify_batch.token[verify_batch.n_tokens]    = draft_tokens[i];
            verify_batch.pos[verify_batch.n_tokens]      = static_cast<llama_pos>(pos);
            verify_batch.n_seq_id[verify_batch.n_tokens] = 1;
            verify_batch.seq_id[verify_batch.n_tokens][0] = 0;
            verify_batch.logits[verify_batch.n_tokens]   = true;
            verify_batch.n_tokens++;
        }

        if (llama_decode(ctx_, verify_batch) != 0) {
            llama_batch_free(verify_batch);
            llama_sampler_free(target_sampler);
            throw std::runtime_error("target verification decode failed");
        }
        result.target_decode_calls += 1;

        std::vector<int32_t> target_predictions;
        target_predictions.reserve(lookahead_n + 1);
        const int32_t base_idx = static_cast<int32_t>(tokens_so_far.size()) - 1;
        for (int i = 0; i <= lookahead_n; ++i) {
            target_predictions.push_back(
                static_cast<int32_t>(llama_sampler_sample(target_sampler, ctx_, base_idx + i)));
        }
        llama_batch_free(verify_batch);

        std::vector<int32_t> draft_tokens_i32(draft_tokens.begin(), draft_tokens.end());
        std::vector<int32_t> accepted =
            resolve_speculative_acceptance(draft_tokens_i32, target_predictions);

        bool hit_eog = false;
        for (int32_t tok : accepted) {
            if (llama_vocab_is_eog(vocab, static_cast<llama_token>(tok))) {
                hit_eog = true;
                break;
            }
            tokens_so_far.push_back(static_cast<llama_token>(tok));
            char piece[128];
            int n = llama_token_to_piece(vocab, static_cast<llama_token>(tok), piece, sizeof(piece), 0, true);
            if (n < 0) {
                llama_sampler_free(target_sampler);
                throw std::runtime_error("failed to convert token to text");
            }
            result.text.append(piece, n);
            result.accepted_tokens += 1;
            if (result.accepted_tokens >= n_predict) {
                break;
            }
        }
        if (hit_eog) {
            break;
        }
    }

    llama_sampler_free(target_sampler);
    return result;
}

}  // namespace swarm
