# Explicit Per-Layer MoE Tensor Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give explicit, per-layer control over which device (local or a specific remote RPC endpoint) hosts a Mixture-of-Experts model's expert tensors, replacing Plan 2's automatic free-memory-proportional split with deliberate placement — demonstrated on a real, tiny MoE model.

**Scope correction (read this first):** the spec originally described "expert sharding" as routing individual experts within a layer to different devices. That is **not achievable** through llama.cpp's public tensor-placement API: a layer's experts are stored as one merged 3D tensor per projection (`blk.N.ffn_gate_exps`, `_down_exps`, `_up_exps`, computed via a single indexed matmul), not as separate per-expert tensors — there is no supported way to put expert 3 on one device and expert 5 of the *same layer* on another without patching llama.cpp's core graph-building code, which is out of scope (real correctness risk in shared foundation code for a small granularity win). See the spec's Model & Sharding Strategy section for the full correction. What this plan actually builds, and what's genuinely achievable: **per-layer** placement — an entire layer's MoE block goes to one chosen device — using llama.cpp's `tensor_buft_overrides` mechanism, verified end-to-end against the real vendored source before this plan was written (see Global Constraints).

**Architecture:** A third `InferenceEngine` constructor overload that accepts explicit per-layer placement rules alongside Plan 2's remote-endpoint list. Each rule names a layer and a target device (local or one of the remote endpoints); the constructor builds `llama_model_tensor_buft_override` entries (regex pattern matched against tensor names via `std::regex_search`, mapped to a `ggml_backend_buffer_type_t`) and passes them via `llama_model_params.tensor_buft_overrides`. Layers not named in a placement rule fall back to Plan 2's automatic placement — this is a sparse-override mechanism, not an exhaustive one, matching how llama.cpp's own API is designed to be used.

**Tech Stack:** Same as Plans 1-2 (C++17, CMake, vendored llama.cpp `b10430`, MinGW/MSYS2, ccache).

## Global Constraints

- Everything from Plans 1-2's Global Constraints still applies (license, no placeholders, C++17, portability, explicit `PATH`/`CCACHE_DIR` exporting).
- **API grounding, verified against the real vendored source before this plan was written — trust these facts, don't re-derive them:**
  - `llama_model_tensor_buft_override { const char* pattern; ggml_backend_buffer_type_t buft; }`, NULL-terminated array (`pattern == nullptr` sentinel), assigned to `llama_model_params.tensor_buft_overrides` (`vendor/llama.cpp/include/llama.h:302-312`).
  - Matching is `std::regex_search(tensor_name, std::regex(pattern))` — substring search, not full match, checked in declaration order, first match wins (`vendor/llama.cpp/src/llama-model-loader.cpp:1170-1194`).
  - A matched override logs `LLAMA_LOG_DEBUG("tensor %s (%zu MiB %s) buffer type overridden to %s\n", ...)` (`llama-model-loader.cpp:1188-1191`) — this is the log line Task 2's tests capture and assert on, the same `llama_log_set` technique already used in Plan 2.
  - `ggml_backend_dev_buffer_type(ggml_backend_dev_t)` returns the buffer type for a device (`vendor/llama.cpp/ggml/include/ggml-backend.h:188`).
  - An RPC device's buffer type name is `"RPC" + device_index + "[" + endpoint + "]"`, e.g. `"RPC0[127.0.0.1:50052]"` (`vendor/llama.cpp/ggml/src/ggml-rpc/ggml-rpc.cpp:766`) — this is the exact string Task 2's remote-placement test looks for in captured log output.
  - MoE expert tensor names follow `blk.N.ffn_gate_exps.weight` / `blk.N.ffn_down_exps.weight` / `blk.N.ffn_up_exps.weight` (`vendor/llama.cpp/src/llama-arch.cpp:410-413`), confirmed against the actual test model in Task 1.
- **Class member ordering, non-negotiable — this is a corrected lesson from Plan 2's review cycle, apply it from the start rather than fixing it after review:** any `std::vector`/`std::string` storage backing a pointer/`const char*` handed to `llama_model_params` (tensor override patterns, the override array itself) MUST be declared as a class member BEFORE `model_` and `ctx_` in `inference_engine.h`, so it is constructed first and destroyed last, structurally guaranteeing it outlives the model regardless of destructor-body content. Do not rely on manual free-ordering in the destructor body to make this safe "by accident."
- Test model for this plan: a real, tiny (90MB) MoE GGUF — `Tiny-Moe.Q4_K_M.gguf` from `mradermacher/Tiny-Moe-GGUF` (a "frankenmoe" built by merging small models via mergekit into a genuine MoE architecture — 12 layers, 2 experts, both active per token, confirmed via `llama.expert_count`/`llama.expert_used_count` GGUF metadata and a real successful load with the existing single-device `InferenceEngine` before this plan was written). Already downloaded and load-tested once during planning; Task 1 formalizes this into the repo's own scripted, checksum-verified fixture, matching the pattern of `download_test_model.sh`.
- URL: `https://huggingface.co/mradermacher/Tiny-Moe-GGUF/resolve/main/Tiny-Moe.Q4_K_M.gguf`
- Size: 90,008,224 bytes
- SHA-256: `c70f8bce32ee5fba3c78e176313579dc21f68ef5c4379929e06f521be9c70cb2`

---

### Task 1: Tiny MoE test model fixture

**Files:**
- Create: `scripts/download_moe_test_model.sh`
- Modify: `core/tests/inference_engine_test.cpp` (one new test)
- Modify: `core/tests/CMakeLists.txt` (one new compile definition for the MoE model path)

**Interfaces:**
- Consumes: the existing single-argument `InferenceEngine(model_path)` constructor from Plan 1 — unchanged.
- Produces: `models/tiny-moe.Q4_K_M.gguf` (gitignored, downloaded on demand) and a `SWARM_MOE_TEST_MODEL_DIR` compile definition Task 2's tests also use.

- [ ] **Step 1: Write the download script**

Create `scripts/download_moe_test_model.sh`, mirroring `scripts/download_test_model.sh`'s hardened structure exactly (portable `sha256sum`/`shasum -a 256` fallback, `.part` + verify-before-move, `set -euo pipefail`):
```bash
#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/models"
MODEL_FILE="$MODEL_DIR/tiny-moe.Q4_K_M.gguf"
MODEL_URL="https://huggingface.co/mradermacher/Tiny-Moe-GGUF/resolve/main/Tiny-Moe.Q4_K_M.gguf"
MODEL_SHA256="c70f8bce32ee5fba3c78e176313579dc21f68ef5c4379929e06f521be9c70cb2"

if command -v sha256sum >/dev/null 2>&1; then
    SHA256_CMD="sha256sum"
else
    SHA256_CMD="shasum -a 256"
fi

mkdir -p "$MODEL_DIR"

if [ -f "$MODEL_FILE" ]; then
    echo "Model already downloaded at $MODEL_FILE"
    exit 0
fi

echo "Downloading Tiny-Moe test model (~90MB) to $MODEL_FILE"
curl -fL --retry 3 -o "$MODEL_FILE.part" "$MODEL_URL"

ACTUAL_SHA256="$($SHA256_CMD "$MODEL_FILE.part" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$MODEL_SHA256" ]; then
    echo "ERROR: downloaded file checksum mismatch (expected $MODEL_SHA256, got $ACTUAL_SHA256)" >&2
    rm -f "$MODEL_FILE.part"
    exit 1
fi

mv "$MODEL_FILE.part" "$MODEL_FILE"
echo "Done."
```

Run:
```bash
chmod +x scripts/download_moe_test_model.sh
./scripts/download_moe_test_model.sh
```
Expected: `models/tiny-moe.Q4_K_M.gguf` exists, exactly 90,008,224 bytes.

- [ ] **Step 2: Add the compile definition**

Add to `core/tests/CMakeLists.txt`, alongside the existing `SWARM_TEST_MODEL_DIR` definition:
```cmake
target_compile_definitions(inference_engine_test PRIVATE
    SWARM_MOE_TEST_MODEL_DIR="${CMAKE_SOURCE_DIR}/models"
)
```
(This can be combined into the same `target_compile_definitions(...)` call that already sets `SWARM_TEST_MODEL_DIR` and `SWARM_RPC_SERVER_PATH` — check the current file and add this as one more definition in that call rather than a separate call, to match existing style.)

- [ ] **Step 3: Write the test**

Add to `core/tests/inference_engine_test.cpp`:
```cpp
#ifndef SWARM_MOE_TEST_MODEL_DIR
#define SWARM_MOE_TEST_MODEL_DIR "models"
#endif

namespace {

std::string moe_test_model_path() {
    return std::string(SWARM_MOE_TEST_MODEL_DIR) + "/tiny-moe.Q4_K_M.gguf";
}

}  // namespace

TEST(InferenceEngine, LoadsMoeModelWithExistingSingleDeviceConstructor) {
    swarm::InferenceEngine engine(moe_test_model_path());

    std::string result = engine.complete("Hello", 8);

    EXPECT_FALSE(result.empty());
}
```

- [ ] **Step 4: Build and run**

```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && export CCACHE_DIR=/c/Users/User/.ccache && cmake --build build --target inference_engine_test && ./build/core/tests/inference_engine_test.exe --gtest_filter=InferenceEngine.LoadsMoeModelWithExistingSingleDeviceConstructor
```
Expected: **PASS** — the existing Plan 1 engine loads and runs this MoE model correctly with no changes, since standard MoE architectures are already fully supported by llama.cpp's normal loading path. This test is the foundation Task 2 builds on, not a regression test for anything currently broken.

- [ ] **Step 5: Commit**

```bash
git add scripts/download_moe_test_model.sh core/tests/inference_engine_test.cpp core/tests/CMakeLists.txt
git commit -m "Add tiny MoE test model fixture"
```

---

### Task 2: Explicit per-layer tensor placement

**Files:**
- Modify: `core/include/swarm/inference_engine.h`
- Modify: `core/src/inference_engine.cpp`
- Modify: `core/tests/inference_engine_test.cpp`

**Interfaces:**
- Consumes: `moe_test_model_path()` and the `RpcServerFixture` test helper from Task 1 / Plan 2 (both already in `inference_engine_test.cpp`); `ggml_backend_dev_buffer_type`, `ggml_backend_rpc_add_server`, `ggml_backend_reg_dev_count`/`_get` from Plan 2's already-verified usage.
- Produces:
  ```cpp
  struct LayerPlacement {
      int layer;
      std::string device_endpoint;  // "local", or one of the strings in remote_endpoints
  };

  InferenceEngine(const std::string& model_path,
                   const std::vector<std::string>& remote_endpoints,
                   const std::vector<LayerPlacement>& layer_placements);
  ```
  No later plan in this repo yet depends on this interface directly, but it's the shape a future coordinator-driven placement decision would call into.

- [ ] **Step 1: Write the failing tests**

Add to `core/tests/inference_engine_test.cpp`:
```cpp
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
    EXPECT_NE(captured_log.find("blk.3.ffn_gate_exps"), std::string::npos);
    EXPECT_NE(captured_log.find("overridden to RPC0[127.0.0.1:50052]"), std::string::npos);
}
```

Note: `LlamaLogCaptureGuard` already exists in this file (added in Plan 2's fix round, `aa51d7b`) — it's an RAII guard whose constructor takes `std::string* out`, calls `llama_log_set` with an internal callback that appends to `*out` and tees to stderr, and restores default logging on destruction. Use it exactly as shown above (construct with the address of a local `std::string`, let it go out of scope at the end of the test) — do not call `llama_log_set` manually alongside it.

Run:
```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && export CCACHE_DIR=/c/Users/User/.ccache && cmake --build build --target inference_engine_test
```
Expected: **FAIL to compile** — `swarm::LayerPlacement` and the three-argument constructor don't exist yet.

- [ ] **Step 2: Declare the new type and constructor**

Add to `core/include/swarm/inference_engine.h`, in the `swarm` namespace alongside the existing `InferenceEngine` class:
```cpp
struct LayerPlacement {
    int layer;
    std::string device_endpoint;
};
```
Add the new constructor declaration to the `InferenceEngine` class:
```cpp
InferenceEngine(const std::string& model_path,
                 const std::vector<std::string>& remote_endpoints,
                 const std::vector<LayerPlacement>& layer_placements);
```
Add two new private members, placed **before** `model_` and `ctx_` (per the Global Constraints ordering rule — check the current header for the exact existing member order, which after Plan 2's fix should already have `devices_` first; add these two alongside it, also before `model_`/`ctx_`):
```cpp
std::vector<std::string> override_patterns_;
std::vector<llama_model_tensor_buft_override> tensor_overrides_;
```

- [ ] **Step 3: Implement the constructor**

Add to `core/src/inference_engine.cpp`:
```cpp
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
            endpoint_buft[endpoint] = ggml_backend_dev_buffer_type(ggml_backend_reg_dev_get(rpc_reg, 0));
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
```

Add `#include <unordered_map>` to the top of the file if not already present.

Check `override_patterns_.back().c_str()` carefully: this is only safe because `override_patterns_` never reallocates after this pointer is taken by a LATER `push_back` on `tensor_overrides_` for a DIFFERENT element — but since `override_patterns_.reserve(layer_placements.size())` runs first and the loop pushes at most `layer_placements.size()` entries, no reallocation happens mid-loop, so every `.c_str()` pointer taken stays valid for the vector's lifetime. If you change the reserve size or the loop structure, re-verify this invariant holds.

If any of `ggml_backend_rpc_add_server`, `ggml_backend_reg_dev_count`, `ggml_backend_reg_dev_get`, or `ggml_backend_dev_buffer_type`'s actual signatures don't match this snippet exactly, check the real vendored headers (`vendor/llama.cpp/ggml/include/ggml-rpc.h`, `ggml-backend.h`) — Plan 2's implementation already used the first three successfully, so cross-check against that existing code in this same file rather than re-deriving from scratch.

- [ ] **Step 4: Run the tests and verify they pass**

```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && export CCACHE_DIR=/c/Users/User/.ccache && cmake --build build --target inference_engine_test && ./build/core/tests/inference_engine_test.exe
```
Expected: **PASS** — all tests, including both new ones. `ExplicitRemotePlacementOverridesSpecificLayer` requires the `swarm-rpc-server` fixture (from Plan 2) to actually start and be reachable — this is already handled by the existing `RpcServerFixture`.

- [ ] **Step 5: Commit**

```bash
git add core/include/swarm/inference_engine.h core/src/inference_engine.cpp core/tests/inference_engine_test.cpp
git commit -m "Add explicit per-layer MoE tensor placement via tensor_buft_overrides"
```

---

## What this plan does not do

Does not achieve true sub-layer per-expert placement (see the Scope Correction above — this is a hard architectural limit of llama.cpp's public API, not a deferred feature). Does not integrate with the coordinator (Plan 3) to make placement decisions automatically — `LayerPlacement` is a mechanism a future coordinator-integration plan would call into, not wired up yet. Does not validate that `layer_placements` covers every layer or that layer indices are in range — an out-of-range layer number simply never matches any real tensor name and silently has no effect (llama.cpp's own override mechanism behaves this way; documenting this as the accepted behavior rather than adding range-validation code for a plan-internal mechanism with no external caller yet).
