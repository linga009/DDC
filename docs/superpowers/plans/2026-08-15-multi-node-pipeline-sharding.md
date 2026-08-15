# Multi-Node Pipeline-Sharded Inference (LAN) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that model computation can be split across two separate processes (standing in for two separate machines on a LAN — the network protocol used doesn't distinguish loopback from LAN) communicating over TCP, building directly on Plan 1's `InferenceEngine`.

**Architecture:** Reuse llama.cpp's own built-in RPC backend (`ggml-rpc`) rather than inventing a custom sharding protocol — it already implements exactly what's needed: a `ggml-rpc-server` process exposes its compute device(s) over TCP, and a client process registers those as additional `ggml_backend_dev_t` devices alongside its local CPU device, and llama.cpp splits model layers across whichever device set is provided. We extend `InferenceEngine` with an optional list of remote endpoints; when given, the model's layers are split between the local device and the remote device(s) instead of running entirely locally.

**Tech Stack:** Same as Plan 1 (C++17, CMake, vendored llama.cpp at tag `b10430`, MinGW/MSYS2 toolchain), plus llama.cpp's `GGML_RPC` build option and its `ggml-rpc.h` / `ggml-backend.h` APIs.

## Global Constraints

- Everything from Plan 1's Global Constraints still applies (license, no placeholders, C++17, portability, explicit `PATH` prepending for the MinGW toolchain, working directory assumed to be repo root unless stated).
- **Security, stated plainly and not glossed over:** llama.cpp's own RPC backend README says outright: *"the functionality is fragile and insecure... Never run the RPC server on an open network or in a sensitive environment."* It has no authentication — anyone who can reach the port can run arbitrary tensor graphs on that machine and read its memory. This is acceptable for this plan's scope (a trusted LAN / same-host processes, proving the mechanism), but it means this exact backend **cannot** be used as-is for the internet-wide federated swarm described in the spec — that's a real, named risk for whichever later plan builds the federation layer (Plan 6), not solved here.
- This plan proves the mechanism using two processes on the same machine (loopback TCP). RPC-over-TCP doesn't distinguish loopback from a real LAN interface, so this is a genuine proof of the protocol working across process boundaries — but it does not by itself prove real-network conditions (latency, packet loss, a second physical machine). That's an honest limitation of what's achievable in this dev environment, not a shortcut taken carelessly.

---

### Task 1: RPC server wrapper executable

**Files:**
- Create: `core/src/rpc_server_main.cpp`
- Modify: `core/CMakeLists.txt` (add `GGML_RPC=ON` to the llama.cpp subdirectory build options, add the new `swarm-rpc-server` executable target)
- Modify: `CMakeLists.txt` (repo root — set `GGML_RPC` before `add_subdirectory(vendor/llama.cpp)`)

**Interfaces:**
- Consumes: `ggml_backend_rpc_start_server` from `vendor/llama.cpp/ggml/include/ggml-rpc.h` (part of the `ggml` target, already a dependency of `llama`).
- Produces: a `swarm-rpc-server` executable that, given a `--port N` argument, starts an RPC server exposing the local CPU device on `127.0.0.1:N` and blocks until killed. Task 2 depends on being able to launch this executable as a subprocess and connect to it.

- [ ] **Step 1: Enable the RPC backend in the build**

Modify the top-level `CMakeLists.txt` — add this line before `add_subdirectory(vendor/llama.cpp)`:
```cmake
set(GGML_RPC ON CACHE BOOL "" FORCE)
```

- [ ] **Step 2: Write the RPC server wrapper**

Create `core/src/rpc_server_main.cpp`:
```cpp
#include "ggml-backend.h"
#include "ggml-rpc.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

int main(int argc, char** argv) {
    int port = 0;
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--port") == 0 && i + 1 < argc) {
            port = std::atoi(argv[++i]);
        }
    }
    if (port <= 0) {
        std::fprintf(stderr, "usage: %s --port N\n", argv[0]);
        return 1;
    }

    ggml_backend_dev_t cpu_dev = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    if (cpu_dev == nullptr) {
        std::fprintf(stderr, "error: no CPU backend device found\n");
        return 1;
    }

    std::string endpoint = "127.0.0.1:" + std::to_string(port);
    std::printf("swarm-rpc-server listening on %s\n", endpoint.c_str());
    std::fflush(stdout);

    ggml_backend_dev_t devices[] = { cpu_dev };
    ggml_backend_rpc_start_server(endpoint.c_str(), /*cache_dir=*/nullptr,
                                   /*n_threads=*/4, /*n_devices=*/1, devices);
    // ggml_backend_rpc_start_server blocks forever serving requests.
    return 0;
}
```

If `ggml_backend_rpc_start_server`'s exact parameter types or count don't match what's actually declared in `vendor/llama.cpp/ggml/include/ggml-rpc.h` at the vendored commit, adjust the call to match the real header — that header is the source of truth, not this snippet.

- [ ] **Step 3: Wire the build target**

Append to `core/CMakeLists.txt`:
```cmake
add_executable(swarm-rpc-server src/rpc_server_main.cpp)
target_link_libraries(swarm-rpc-server PRIVATE ggml)
```

If the RPC symbols live in a different exported target name than `ggml` once `GGML_RPC=ON` is set (e.g. a separate `ggml-rpc` target), link against whatever target actually exports `ggml_backend_rpc_start_server` — check `vendor/llama.cpp/ggml/src/CMakeLists.txt` for how the RPC backend is registered if `ggml` alone doesn't link.

- [ ] **Step 4: Build and manually verify the server starts**

Run:
```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build --target swarm-rpc-server
```
Expected: builds with no errors.

Then, in one terminal-equivalent (background it with a timeout, since it blocks forever):
```bash
timeout 5 ./build/core/swarm-rpc-server.exe --port 50052; echo "exit code: $?"
```
Expected: prints `swarm-rpc-server listening on 127.0.0.1:50052` before being killed by `timeout` (a nonzero/signal exit code from `timeout` itself is expected and fine — the point is confirming the startup message appears, proving the server initializes and blocks rather than exiting immediately or crashing).

- [ ] **Step 5: Commit**

```bash
git add CMakeLists.txt core/CMakeLists.txt core/src/rpc_server_main.cpp
git commit -m "Add swarm-rpc-server: expose local CPU device over RPC"
```

---

### Task 2: `InferenceEngine` support for remote devices

**Files:**
- Modify: `core/include/swarm/inference_engine.h`
- Modify: `core/src/inference_engine.cpp`
- Modify: `core/tests/inference_engine_test.cpp`

**Interfaces:**
- Consumes: the `swarm-rpc-server` executable from Task 1 (tests launch it as a subprocess), and `ggml_backend_rpc_add_server` / `ggml_backend_dev_by_type` from `ggml-rpc.h` / `ggml-backend.h`.
- Produces: a new `InferenceEngine` constructor overload: `InferenceEngine(const std::string& model_path, const std::vector<std::string>& remote_endpoints)`. When `remote_endpoints` is non-empty, the model is loaded with its layers split across the local CPU device and the given remote RPC device(s) instead of running entirely locally. The existing single-argument constructor from Plan 1 is unchanged and continues to run entirely locally.

- [ ] **Step 1: Write the failing tests**

Append to `core/tests/inference_engine_test.cpp`. These tests need a running `swarm-rpc-server` subprocess — add a small test fixture helper at the top of the file (above the existing tests) that launches and tears down the server:

```cpp
#include <cstdlib>
#include <thread>
#include <chrono>

namespace {

class RpcServerFixture : public ::testing::Test {
protected:
    void SetUp() override {
#ifdef _WIN32
        std::string cmd = "start /B \"\" \"" SWARM_RPC_SERVER_PATH "\" --port 50052 > NUL 2>&1";
#else
        std::string cmd = "\"" SWARM_RPC_SERVER_PATH "\" --port 50052 > /dev/null 2>&1 &";
#endif
        std::system(cmd.c_str());
        // give the server a moment to bind the port before tests connect
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
};

}  // namespace

TEST_F(RpcServerFixture, SplitsAcrossLocalAndRemoteDevice) {
    swarm::InferenceEngine engine(test_model_path(), std::vector<std::string>{"127.0.0.1:50052"});

    std::string result = engine.complete("The capital of France is", 8);

    EXPECT_FALSE(result.empty());
}

TEST(InferenceEngine, ThrowsIfRemoteEndpointUnreachable) {
    // Port 50099 has no server listening -- this proves the remote device is
    // genuinely required (not silently falling back to local-only) when a
    // remote-only device list is requested.
    EXPECT_THROW(
        (swarm::InferenceEngine(test_model_path(), std::vector<std::string>{"127.0.0.1:50099"})),
        std::runtime_error);
}
```

Note: `SWARM_RPC_SERVER_PATH` is a compile definition you'll add in Step 2's CMake changes, giving the absolute path to the built `swarm-rpc-server` executable. The `RpcServerFixture` test process is deliberately left running after the test (no `TearDown` kill) — cleaning it up is a nice-to-have, not required for this task; note this as a known limitation in your report rather than spending time on cross-platform process management.

- [ ] **Step 2: Add the compile definition and confirm the tests fail**

Add to `core/tests/CMakeLists.txt` (alongside the existing `SWARM_TEST_MODEL_DIR` definition):
```cmake
target_compile_definitions(inference_engine_test PRIVATE
    SWARM_RPC_SERVER_PATH="$<TARGET_FILE:swarm-rpc-server>"
)
```

Add this line to `core/include/swarm/inference_engine.h`'s includes: `#include <vector>`, and declare the new constructor overload:
```cpp
InferenceEngine(const std::string& model_path, const std::vector<std::string>& remote_endpoints);
```

Run:
```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && cmake -S . -B build -G Ninja && cmake --build build --target inference_engine_test
```
Expected: **FAIL** — linker error, undefined reference to the new constructor overload (declared but not yet implemented).

- [ ] **Step 3: Implement the remote-device constructor**

Add to `core/src/inference_engine.cpp`, alongside the existing constructor (include `"ggml-backend.h"` and `"ggml-rpc.h"` at the top, alongside the existing `"llama.h"` include):

```cpp
InferenceEngine::InferenceEngine(const std::string& model_path,
                                  const std::vector<std::string>& remote_endpoints) {
    ggml_backend_load_all();

    std::vector<ggml_backend_dev_t> devices;

    ggml_backend_dev_t local_cpu = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    if (local_cpu != nullptr) {
        devices.push_back(local_cpu);
    }

    for (const auto& endpoint : remote_endpoints) {
        ggml_backend_reg_t rpc_reg = ggml_backend_rpc_add_server(endpoint.c_str());
        if (rpc_reg == nullptr) {
            throw std::runtime_error("failed to reach RPC endpoint: " + endpoint);
        }
        size_t n = ggml_backend_reg_dev_count(rpc_reg);
        for (size_t i = 0; i < n; ++i) {
            devices.push_back(ggml_backend_reg_dev_get(rpc_reg, i));
        }
    }
    devices.push_back(nullptr);  // NULL-terminated, per llama_model_params.devices contract

    llama_model_params model_params = llama_model_default_params();
    model_params.devices = devices.data();
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
```

Check `ggml_backend_rpc_add_server`'s actual return-value semantics against `vendor/llama.cpp/ggml/include/ggml-rpc.h` and `vendor/llama.cpp/ggml/src/ggml-rpc.cpp` — confirm whether it truly returns `nullptr` on connection failure (matching the `ThrowsIfRemoteEndpointUnreachable` test's expectation) or whether failure surfaces differently (e.g., only failing later, at `llama_model_load_from_file` time, when the device is actually used). If it's the latter, move the "did we actually get a usable device" check to after the model-load call instead, adjusting the thrown error accordingly — the test's intent (remote-only device list + unreachable server = a clear thrown exception, not a silent hang or crash) is what matters, not the exact call site of the check.

- [ ] **Step 4: Run the tests and verify they pass**

Run:
```bash
export PATH="/c/msys64/ucrt64/bin:$PATH" && cmake --build build --target inference_engine_test && ./build/core/tests/inference_engine_test.exe
```
Expected: **PASS** — all tests including the two new ones. `SplitsAcrossLocalAndRemoteDevice` should show (via llama.cpp's own startup logging, which is verbose and fine to leave visible) that more than one device was used to load the model.

- [ ] **Step 5: Commit**

```bash
git add core/include/swarm/inference_engine.h core/src/inference_engine.cpp core/tests/inference_engine_test.cpp core/tests/CMakeLists.txt
git commit -m "Add InferenceEngine support for splitting inference across a remote RPC device"
```

---

## What this plan does not do

Does not test across two genuinely separate physical machines (only two processes on one host, communicating over the same TCP/RPC code path a real LAN deployment would use). Does not add authentication or encryption to the RPC channel — explicitly out of scope per the Global Constraints, and a named risk for the federation plan. Does not integrate with a coordinator or do any capacity-aware routing — that's Plan 3.
