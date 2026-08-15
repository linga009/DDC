# Speculative Decoding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the number of round-trips through the target model's decode call by verifying several draft-proposed tokens in one batched pass instead of decoding one token at a time — directly serving the spec's stated goal of reducing round-trips through a (potentially RPC-distributed, per Plan 2) target model.

**Architecture:** A small, pure, fully unit-testable function (`resolve_speculative_acceptance`) implements the standard speculative-decoding accept/reject rule on plain token-ID vectors — no model, no I/O, easy to get exhaustively right. A new `InferenceEngine::complete_speculative()` method wires this to two real `InferenceEngine` instances (a "draft" and `this` as "target"): each round, the draft proposes `lookahead` tokens one at a time (cheap, single-token steps), then the target verifies all of them in **one** batched `llama_decode` call using a manually-constructed batch that requests logits at every position — that single call is the round-trip reduction. Uses llama.cpp's raw C API directly (no dependency on llama.cpp's `common/` helper library, consistent with every prior plan in this project).

**Deliberate simplification, stated plainly:** each round clears and fully redecodes the accepted-so-far context on both draft and target, rather than maintaining an incrementally-updated KV cache across rounds. This is O(n²) total work over a full generation instead of the fully-optimized O(n) of a production speculative-decoding implementation — for this plan's short test-scale generations (tens of tokens), that cost is negligible, and it removes an entire class of KV-cache-surgery bugs (partial sequence removal, position bookkeeping across rounds) in exchange for code that's straightforward to get correct and review. Incremental KV-cache-preserving speculative decoding is a valid future optimization, not attempted here.

**On draft/target model choice:** the tests use the *same* model (TinyLlama, already in this repo) as both draft and target. This sidesteps a real constraint of speculative decoding — draft and target must share a tokenizer/vocabulary — entirely, while still exercising the full mechanism end-to-end (batched verification, accept/reject, round-trip counting). It will not show a wall-clock speedup (draft and target cost the same), only the round-trip reduction the spec actually asks for. A genuinely smaller/faster draft model is a drop-in swap (pass a different `InferenceEngine` instance to `draft`), not a design change.

**Tech Stack:** Same as prior plans (C++17, CMake, vendored llama.cpp `b10430`, MinGW/MSYS2, ccache).

## Global Constraints

- Everything from Plans 1-2's Global Constraints still applies.
- **API grounding, verified against the real vendored source and llama.cpp's own official `examples/speculative-simple/` (for the reference algorithm shape) before this plan was written — trust these facts:**
  - `llama_batch_get_one(tokens, n)` sets `batch.logits = nullptr`, which llama.cpp interprets as "only compute logits for the last position" (`vendor/llama.cpp/src/llama-batch.cpp:120-130`). This is why the target's verification batch needs `llama_batch_init` instead — to request logits at *every* position being verified, not just the last.
  - `llama_batch_init(n_tokens_alloc, embd, n_seq_max)` allocates a batch you populate manually. Per-token fields, following the exact pattern of llama.cpp's own `common_batch_add` helper (`vendor/llama.cpp/common/common.cpp:1811-1828`, reproduced here since this project doesn't link the `common` library): `batch.token[n]`, `batch.pos[n]` (absolute position in the sequence), `batch.n_seq_id[n] = 1`, `batch.seq_id[n][0] = 0`, `batch.logits[n]` (whether you want logits at this position), then `batch.n_tokens++`. Free with `llama_batch_free(batch)` when done (unlike `llama_batch_get_one`, which allocates nothing to free).
  - `llama_get_logits_ith(ctx, i)` / `llama_sampler_sample(sampler, ctx, i)` both accept an arbitrary batch-position index `i` (`vendor/llama.cpp/src/llama-sampler.cpp:895`), not just `-1` (last) — Plan 1 only ever used `-1`; this plan is the first to sample at arbitrary positions, which requires that position's `logits[i]` to have been `true` in the batch that was decoded.
  - Decoding a batch of tokens `[t0, t1, ..., t(K-1)]` appended after existing context, with `logits[i]=true` for every position, gives you K sets of logits: `logits` at batch-position `i` is the model's prediction for the token that comes *after* `t_i`. So to verify K draft tokens, decode `[t0..t(K-1)]` and read logits at positions `0..K-1`, PLUS one more position — the *last position of the existing context, before any draft token* — to check whether the target agrees with `t0` in the first place. This plan's redecode-everything-each-round design makes this simple: each round decodes `tokens_so_far + draft_tokens` as one combined batch with logits requested at every position, so the needed "K+1 predictions" are just the logits at batch-positions `[len(tokens_so_far)-1, ..., len(tokens_so_far)+K-1]`.
- Test model: reuses the existing `models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf` (from Plan 1) as both draft and target — no new model download needed for this plan.

---

### Task 1: Pure speculative-decoding accept/reject resolution

**Files:**
- Modify: `core/include/swarm/inference_engine.h`
- Create: `core/src/speculative.cpp`
- Create: `core/tests/speculative_test.cpp`
- Modify: `core/CMakeLists.txt` (add the new source file to the `inference_engine` library)
- Modify: `core/tests/CMakeLists.txt` (add the new test file to the test executable)

**Interfaces:**
- Consumes: nothing (pure function, no model dependency).
- Produces:
  ```cpp
  namespace swarm {
  std::vector<int32_t> resolve_speculative_acceptance(
      const std::vector<int32_t>& draft_tokens,
      const std::vector<int32_t>& target_predictions);
  }
  ```
  Task 2 consumes this directly. Token IDs are `int32_t` here (matching llama.cpp's `llama_token` typedef) rather than `llama_token` itself, so this header doesn't need to include `llama.h` — consistent with the existing header's forward-declaration-only style.

- [ ] **Step 1: Write the failing tests**

Create `core/tests/speculative_test.cpp`:
```cpp
#include "swarm/inference_engine.h"

#include <gtest/gtest.h>

TEST(ResolveSpeculativeAcceptance, AcceptsAllDraftTokensPlusBonus) {
    std::vector<int32_t> draft{1, 2, 3};
    std::vector<int32_t> target{1, 2, 3, 99};

    auto accepted = swarm::resolve_speculative_acceptance(draft, target);

    EXPECT_EQ(accepted, (std::vector<int32_t>{1, 2, 3, 99}));
}

TEST(ResolveSpeculativeAcceptance, AcceptsPartialPrefixThenCorrects) {
    std::vector<int32_t> draft{1, 2, 3};
    std::vector<int32_t> target{1, 5, 3, 99};

    auto accepted = swarm::resolve_speculative_acceptance(draft, target);

    EXPECT_EQ(accepted, (std::vector<int32_t>{1, 5}));
}

TEST(ResolveSpeculativeAcceptance, RejectsImmediatelyOnFirstMismatch) {
    std::vector<int32_t> draft{1, 2, 3};
    std::vector<int32_t> target{7, 2, 3, 99};

    auto accepted = swarm::resolve_speculative_acceptance(draft, target);

    EXPECT_EQ(accepted, (std::vector<int32_t>{7}));
}

TEST(ResolveSpeculativeAcceptance, HandlesSingleTokenDraft) {
    std::vector<int32_t> draft{42};
    std::vector<int32_t> target{42, 100};

    auto accepted = swarm::resolve_speculative_acceptance(draft, target);

    EXPECT_EQ(accepted, (std::vector<int32_t>{42, 100}));
}
```

Add `core/tests/speculative_test.cpp` to the test executable's sources in `core/tests/CMakeLists.txt` (check the current file for how `inference_engine_test` is defined — likely `add_executable(inference_engine_test inference_engine_test.cpp)` — add the new file as a second source: `add_executable(inference_engine_test inference_engine_test.cpp speculative_test.cpp)`).

Run:
```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && export CCACHE_DIR=/c/Users/User/.ccache && cmake -S . -B build -G Ninja && cmake --build build --target inference_engine_test
```
Expected: **FAIL to compile** — `swarm::resolve_speculative_acceptance` doesn't exist yet.

- [ ] **Step 2: Declare the function**

Add to `core/include/swarm/inference_engine.h`, in the `swarm` namespace, above the `InferenceEngine` class (needs `#include <cstdint>` and `#include <vector>`, both likely already present — check):
```cpp
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
```

- [ ] **Step 3: Implement it**

Create `core/src/speculative.cpp`:
```cpp
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
```

Add `src/speculative.cpp` to `core/CMakeLists.txt`'s `add_library(inference_engine ...)` sources list (alongside the existing `src/inference_engine.cpp`).

- [ ] **Step 4: Run the tests and verify they pass**

```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && export CCACHE_DIR=/c/Users/User/.ccache && cmake --build build --target inference_engine_test && ./build/core/tests/inference_engine_test.exe --gtest_filter=ResolveSpeculativeAcceptance.*
```
Expected: **PASS** — all 4 tests. These run instantly (no model, no I/O).

- [ ] **Step 5: Commit**

```bash
git add core/include/swarm/inference_engine.h core/src/speculative.cpp core/tests/speculative_test.cpp core/CMakeLists.txt core/tests/CMakeLists.txt
git commit -m "Add resolve_speculative_acceptance: pure speculative-decoding accept/reject logic"
```

---

### Task 2: `complete_speculative()` end-to-end integration

**Files:**
- Modify: `core/include/swarm/inference_engine.h`
- Modify: `core/src/inference_engine.cpp`
- Modify: `core/tests/inference_engine_test.cpp`

**Interfaces:**
- Consumes: `resolve_speculative_acceptance` from Task 1; the existing `InferenceEngine` constructor and private `model_`/`ctx_` members (accessed on the `draft` parameter directly — private members are accessible between instances of the same class in C++, so no new public accessors are needed on `InferenceEngine` itself for this).
- Produces:
  ```cpp
  namespace swarm {
  struct SpeculativeResult {
      std::string text;
      int accepted_tokens = 0;
      int target_decode_calls = 0;
  };
  }
  // member of InferenceEngine:
  SpeculativeResult complete_speculative(const std::string& prompt, int n_predict,
                                          InferenceEngine& draft, int lookahead);
  ```
  No later plan yet depends on this interface.

- [ ] **Step 1: Write the failing tests**

Add to `core/tests/inference_engine_test.cpp`:
```cpp
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
```

Run:
```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && export CCACHE_DIR=/c/Users/User/.ccache && cmake --build build --target inference_engine_test
```
Expected: **FAIL to compile** — `SpeculativeResult` and `complete_speculative` don't exist yet.

- [ ] **Step 2: Declare the new type and method**

Add to `core/include/swarm/inference_engine.h`, in the `swarm` namespace, alongside `resolve_speculative_acceptance`:
```cpp
struct SpeculativeResult {
    std::string text;
    int accepted_tokens = 0;
    int target_decode_calls = 0;
};
```
Add the method declaration to the `InferenceEngine` class:
```cpp
SpeculativeResult complete_speculative(const std::string& prompt, int n_predict,
                                         InferenceEngine& draft, int lookahead);
```

- [ ] **Step 3: Implement it**

Add to `core/src/inference_engine.cpp` (needs `#include <algorithm>` for `std::min`, alongside the existing includes):
```cpp
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
```

Check this against the real vendored headers/source before trusting it verbatim — in particular, verify `llama_batch_init`'s exact field types (`token`, `pos`, `n_seq_id`, `seq_id`, `logits` array shapes) match how they're indexed here by reading `vendor/llama.cpp/include/llama.h`'s `llama_batch` struct definition directly, and cross-check the manual population against `vendor/llama.cpp/common/common.cpp:1811-1828`'s `common_batch_add` (cited in Global Constraints) since that's llama.cpp's own reference implementation of exactly this pattern. If anything doesn't match, the real header/source is the source of truth, not this snippet.

- [ ] **Step 4: Run the tests and verify they pass**

```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && export CCACHE_DIR=/c/Users/User/.ccache && cmake --build build --target inference_engine_test && ./build/core/tests/inference_engine_test.exe
```
Expected: **PASS** — all tests, including the three new ones. Before wiring in the accept/reject logic, it's worth sanity-checking during development (not necessarily as a committed test) that the target's per-position predictions from a single verify batch look like real, plausible tokens (e.g. print them and eyeball that they decode to real words) — this significantly de-risks debugging the batch/position/logits plumbing, which is the most intricate part of this task.

- [ ] **Step 5: Commit**

```bash
git add core/include/swarm/inference_engine.h core/src/inference_engine.cpp core/tests/inference_engine_test.cpp
git commit -m "Add complete_speculative(): batched multi-token verification against a draft model"
```

---

## What this plan does not do

Does not preserve KV cache state incrementally across rounds (see the deliberate simplification above — O(n²) total work, fine at this plan's test scale, a real inefficiency at production scale). Does not integrate with Plan 2's remote-device constructor — `complete_speculative` uses the plain single-device engine for both draft and target in this plan; combining speculative decoding with a *remote* target (so the batched verification call is itself an RPC round-trip, which is the actual production motivation from the spec) is natural follow-on work, not attempted here to keep this plan's scope to the decoding algorithm itself. Does not use a genuinely smaller/faster draft model (see above — same model for both, proving the mechanism, not the speedup). Does not handle multiple sequences/parallel speculation (`n_seq_max` is hardcoded to `1` throughout).
