# Core Inference Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native C++ library that loads a small open-weight GGUF model and generates a text completion for a prompt, exposed via a CLI — the foundation every later plan (multi-node sharding, coordinator, federation, clients) builds on.

**Architecture:** A thin `InferenceEngine` C++ class wraps llama.cpp's C API (model load, tokenize, decode, sample) behind a two-method interface (`complete`), vendored as a pinned git submodule and built via CMake. A minimal CLI (`swarm-cli`) links against it. No networking, no sharding, no UI — single process, single device, proves the one thing nothing else can be built without: a real prompt in, a real completion out.

**Tech Stack:** C++17, CMake 3.14+, llama.cpp (tag `b10430`, vendored as a git submodule), GoogleTest v1.18.0 (fetched via CMake `FetchContent`), MSYS2/MinGW-w64 GCC + Ninja toolchain on this Windows dev machine.

## Global Constraints

- License: Apache 2.0 for all new source files (per spec's Open Source Strategy) — this plan does not add license headers yet (no LICENSE file exists in the repo yet); note this as a gap for whichever plan first publishes the repo publicly.
- No placeholders, TODOs, or stubbed-out error handling — every code path either works or explicitly throws with a clear message.
- C++17 minimum (required by GoogleTest v1.18.0 and used throughout).
- The core library must stay portable to Linux/macOS even though this plan is executed on Windows — achieved by using only CMake + llama.cpp + the C++ standard library, no Windows-specific APIs.
- Every command below assumes the working directory is the repo root, `C:\Users\User\DDC`, unless a step says otherwise.
- The MinGW/MSYS2 toolchain is not on `PATH` by default in a fresh shell. Every command that invokes `cmake`, `g++`, or `ninja` explicitly prepends `/c/msys64/ucrt64/bin` to `PATH` in the same command — do not rely on `PATH` persisting between separate command invocations.

---

### Task 1: Development toolchain + repo scaffolding + llama.cpp vendored and building

**Files:**
- Create: `CMakeLists.txt` (repo root)
- Create: `.gitignore`
- Create: `vendor/llama.cpp` (git submodule, pinned to tag `b10430`)
- Test: none (this task's "test" is: the build configures and compiles llama.cpp successfully — verified in Step 6)

Note: `core/CMakeLists.txt` is created in Task 2, not here — Task 1's root `CMakeLists.txt` only references `vendor/llama.cpp`.

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a working CMake build tree at `build/` that successfully compiles the `llama` target from the vendored submodule. Later tasks link against the `llama` CMake target this produces.

- [ ] **Step 1: Install the MSYS2/MinGW-w64 toolchain**

Run:
```bash
winget install --id=MSYS2.MSYS2 -e --accept-package-agreements --accept-source-agreements
```
Expected: installer completes, MSYS2 is installed to `C:\msys64`.

- [ ] **Step 2: Install GCC, CMake, and Ninja via pacman**

Run:
```bash
/c/msys64/usr/bin/pacman.exe -Syu --noconfirm
/c/msys64/usr/bin/pacman.exe -S --needed --noconfirm mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-cmake mingw-w64-ucrt-x86_64-ninja
```
Expected: packages install with no errors. The first command may report it needs to close and be re-run once if MSYS2 core packages were updated — if so, re-run both lines.

- [ ] **Step 3: Verify the toolchain is usable**

Run:
```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && cmake --version && g++ --version && ninja --version
```
Expected: version output for all three (CMake 3.2x+, GCC 13+, Ninja 1.1x+), no "command not found".

- [ ] **Step 4: Scaffold the repo structure and .gitignore**

Run:
```bash
mkdir -p core/include/swarm core/src core/tests models
```

Create `.gitignore`:
```
/build/
/models/
```

- [ ] **Step 5: Vendor llama.cpp as a pinned git submodule**

Run:
```bash
git submodule add https://github.com/ggml-org/llama.cpp.git vendor/llama.cpp
cd vendor/llama.cpp && git checkout b10430 && cd ../..
```
Expected: `vendor/llama.cpp` is populated and checked out at tag `b10430` (detached HEAD).

- [ ] **Step 6: Write the top-level CMakeLists.txt and build it**

Create `CMakeLists.txt`:
```cmake
cmake_minimum_required(VERSION 3.14)
project(swarm_llm CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_subdirectory(vendor/llama.cpp)
```

Run:
```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && cmake -G Ninja -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --target llama
```
Expected: configure succeeds, and the build compiles the `llama` target with no errors (this will take a few minutes the first time).

- [ ] **Step 7: Commit**

```bash
git add CMakeLists.txt .gitignore .gitmodules vendor/llama.cpp
git commit -m "Scaffold repo and vendor llama.cpp (b10430) as a git submodule"
```

---

### Task 2: `InferenceEngine` model loading (TDD)

**Files:**
- Create: `core/include/swarm/inference_engine.h`
- Create: `core/src/inference_engine.cpp`
- Create: `core/tests/inference_engine_test.cpp`
- Create: `core/tests/CMakeLists.txt`
- Create: `core/CMakeLists.txt`
- Modify: `CMakeLists.txt` (add `add_subdirectory(core)`)
- Create: `scripts/download_test_model.sh`

**Interfaces:**
- Consumes: the `llama` CMake target produced by Task 1.
- Produces: `swarm::InferenceEngine` class with constructor `InferenceEngine(const std::string& model_path)` (throws `std::runtime_error` if the model fails to load) and destructor. Task 3 adds a `complete()` method to this same class.

- [ ] **Step 1: Write the test-model download script**

Create `scripts/download_test_model.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/models"
MODEL_FILE="$MODEL_DIR/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf"
MODEL_URL="https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf"

mkdir -p "$MODEL_DIR"

if [ -f "$MODEL_FILE" ]; then
    echo "Model already downloaded at $MODEL_FILE"
    exit 0
fi

echo "Downloading TinyLlama test model (~669MB) to $MODEL_FILE"
curl -L -o "$MODEL_FILE" "$MODEL_URL"
echo "Done."
```

Run:
```bash
chmod +x scripts/download_test_model.sh
./scripts/download_test_model.sh
```
Expected: `models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf` exists and is ~669MB.

- [ ] **Step 2: Write the public header**

Create `core/include/swarm/inference_engine.h`:
```cpp
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
```

- [ ] **Step 3: Write the failing tests**

Create `core/tests/inference_engine_test.cpp`:
```cpp
#include "swarm/inference_engine.h"

#include <gtest/gtest.h>

#include <stdexcept>
#include <string>

#ifndef SWARM_TEST_MODEL_DIR
#define SWARM_TEST_MODEL_DIR "models"
#endif

namespace {

std::string test_model_path() {
    return std::string(SWARM_TEST_MODEL_DIR) + "/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf";
}

}  // namespace

TEST(InferenceEngine, ThrowsOnInvalidModelPath) {
    EXPECT_THROW(swarm::InferenceEngine engine("does/not/exist.gguf"), std::runtime_error);
}

TEST(InferenceEngine, LoadsValidModel) {
    EXPECT_NO_THROW(swarm::InferenceEngine engine(test_model_path()));
}
```

- [ ] **Step 4: Write the test/build wiring and confirm the tests fail**

Create `core/tests/CMakeLists.txt`:
```cmake
include(FetchContent)
FetchContent_Declare(
    googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.18.0.zip
)
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

add_executable(inference_engine_test inference_engine_test.cpp)
target_link_libraries(inference_engine_test PRIVATE inference_engine GTest::gtest_main)
target_compile_definitions(inference_engine_test PRIVATE
    SWARM_TEST_MODEL_DIR="${CMAKE_SOURCE_DIR}/models"
)

include(GoogleTest)
gtest_discover_tests(inference_engine_test)
```

Create `core/CMakeLists.txt`:
```cmake
add_library(inference_engine
    src/inference_engine.cpp
)
target_include_directories(inference_engine PUBLIC include)
target_link_libraries(inference_engine PUBLIC llama)
target_compile_features(inference_engine PUBLIC cxx_std_17)

enable_testing()
add_subdirectory(tests)
```

Modify `CMakeLists.txt` (repo root) — add this line at the end:
```cmake
add_subdirectory(core)
```

Create an empty stub so the build compiles enough to run and fail on link (not on missing symbols due to a totally absent .cpp): create `core/src/inference_engine.cpp` with just:
```cpp
#include "swarm/inference_engine.h"
```

Run:
```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build --target inference_engine_test
```
Expected: **FAIL** — linker error, undefined reference to `swarm::InferenceEngine::InferenceEngine(std::string const&)` and the destructor (the class has no implementation yet).

- [ ] **Step 5: Implement model loading**

Replace `core/src/inference_engine.cpp` with:
```cpp
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
```

- [ ] **Step 6: Run the tests and verify they pass**

Run:
```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && cmake --build build --target inference_engine_test && ./build/core/tests/inference_engine_test.exe
```
Expected: **PASS** — both `InferenceEngine.ThrowsOnInvalidModelPath` and `InferenceEngine.LoadsValidModel` pass. (This step actually loads the real TinyLlama model, so it will take a few seconds.)

- [ ] **Step 7: Commit**

```bash
git add core/ CMakeLists.txt scripts/download_test_model.sh
git commit -m "Add InferenceEngine model loading with tests"
```

Note: `models/` is gitignored — the downloaded GGUF file is never committed.

---

### Task 3: `InferenceEngine::complete()` text generation (TDD)

**Files:**
- Modify: `core/tests/inference_engine_test.cpp`
- Modify: `core/src/inference_engine.cpp`

**Interfaces:**
- Consumes: `swarm::InferenceEngine` constructor from Task 2.
- Produces: `std::string InferenceEngine::complete(const std::string& prompt, int n_predict)` — generates up to `n_predict` tokens continuing `prompt` and returns the generated text (not including the prompt itself). Task 4's CLI consumes this method.

- [ ] **Step 1: Add the failing test**

Append to `core/tests/inference_engine_test.cpp`:
```cpp
TEST(InferenceEngine, GeneratesNonEmptyCompletion) {
    swarm::InferenceEngine engine(test_model_path());

    std::string result = engine.complete("The capital of France is", 8);

    EXPECT_FALSE(result.empty());
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run:
```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && cmake --build build --target inference_engine_test && ./build/core/tests/inference_engine_test.exe --gtest_filter=InferenceEngine.GeneratesNonEmptyCompletion
```
Expected: **FAIL** — `complete()` throws `std::runtime_error("not implemented yet")`.

- [ ] **Step 3: Implement text generation**

Replace the `complete()` implementation at the bottom of `core/src/inference_engine.cpp` (delete the `throw std::runtime_error("not implemented yet");` stub version) with:
```cpp
std::string InferenceEngine::complete(const std::string& prompt, int n_predict) {
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
```

Add these includes to the top of `core/src/inference_engine.cpp`, alongside the existing `#include "llama.h"` and `#include <stdexcept>`:
```cpp
#include <vector>
```

- [ ] **Step 4: Run all tests and verify they pass**

Run:
```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && cmake --build build --target inference_engine_test && ./build/core/tests/inference_engine_test.exe
```
Expected: **PASS** — all three tests pass.

- [ ] **Step 5: Commit**

```bash
git add core/src/inference_engine.cpp core/tests/inference_engine_test.cpp
git commit -m "Implement InferenceEngine::complete() text generation"
```

---

### Task 4: `swarm-cli` command-line executable

**Files:**
- Create: `core/src/main.cpp`
- Modify: `core/CMakeLists.txt`

**Interfaces:**
- Consumes: `swarm::InferenceEngine` (constructor + `complete()`) from Tasks 2 and 3.
- Produces: a `swarm-cli` executable. No later task in this plan depends on this interface; this is the plan's end-user-visible deliverable.

- [ ] **Step 1: Write the CLI**

Create `core/src/main.cpp`:
```cpp
#include "swarm/inference_engine.h"

#include <cstdio>
#include <string>

int main(int argc, char** argv) {
    std::string model_path;
    std::string prompt = "Hello, my name is";
    int n_predict = 32;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--model" && i + 1 < argc) {
            model_path = argv[++i];
        } else if (arg == "--n-predict" && i + 1 < argc) {
            n_predict = std::stoi(argv[++i]);
        } else {
            prompt = arg;
        }
    }

    if (model_path.empty()) {
        std::fprintf(stderr, "usage: %s --model <path.gguf> [--n-predict N] [prompt]\n", argv[0]);
        return 1;
    }

    swarm::InferenceEngine engine(model_path);
    std::string result = engine.complete(prompt, n_predict);

    std::printf("%s%s\n", prompt.c_str(), result.c_str());
    return 0;
}
```

- [ ] **Step 2: Wire it into the build**

Append to `core/CMakeLists.txt` (before the `enable_testing()` line):
```cmake
add_executable(swarm-cli src/main.cpp)
target_link_libraries(swarm-cli PRIVATE inference_engine)
```

- [ ] **Step 3: Build it**

Run:
```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && cmake --build build --target swarm-cli
```
Expected: builds with no errors, producing `build/core/swarm-cli.exe`.

- [ ] **Step 4: Run it manually and verify real output**

Run:
```bash
./build/core/swarm-cli.exe --model models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf --n-predict 16 "The capital of France is"
```
Expected: prints the prompt followed by generated text continuing it (e.g. something like "The capital of France is Paris. It is..." — exact wording depends on the model's sampling, but output must be non-empty and readable text, not an error).

- [ ] **Step 5: Commit**

```bash
git add core/src/main.cpp core/CMakeLists.txt
git commit -m "Add swarm-cli command-line executable"
```

---

## What this plan does not do

No networking, no sharding across multiple devices, no coordinator, no chat UI, no safety classifier — those are Plans 2 onward (see the plan sequence discussed with the user). This plan's sole job is proving that a real open-weight model can be loaded and run locally through code this project owns, which every later plan builds on top of.
