#include "swarm/inference_engine.h"

namespace swarm {

std::vector<int32_t> resolve_speculative_acceptance(
    const std::vector<int32_t>& draft_tokens,
    const std::vector<int32_t>& target_predictions) {
    size_t match_len = 0;
    while (match_len < draft_tokens.size() &&
           draft_tokens[match_len] == target_predictions[match_len]) {
        ++match_len;
    }

    std::vector<int32_t> accepted(draft_tokens.begin(), draft_tokens.begin() + match_len);
    accepted.push_back(target_predictions[match_len]);
    return accepted;
}

}  // namespace swarm
