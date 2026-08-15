# swarm-llm

A native C++ inference engine (`swarm::InferenceEngine`, a wrapper around
[llama.cpp](https://github.com/ggml-org/llama.cpp)) and a `swarm-cli`
command-line executable for running local LLM inference.

This repo implements the first foundational plan from the project vision (a
local, single-device inference engine) plus an early piece of the second
plan's networking layer: the `coordinator/` service described below. Sharding
and federation are not yet implemented — see
[`docs/superpowers/specs/2026-08-14-distributed-llm-inference-design.md`](docs/superpowers/specs/2026-08-14-distributed-llm-inference-design.md)
for the full design of where this is headed.

## Prerequisites

- **Windows:** [MSYS2](https://www.msys2.org/) with the MinGW-w64 UCRT64
  toolchain (`mingw-w64-ucrt-x86_64-gcc`, `mingw-w64-ucrt-x86_64-cmake`,
  `mingw-w64-ucrt-x86_64-ninja`).
- **Linux/macOS:** an equivalent C++17 toolchain (GCC or Clang, CMake, and
  Ninja).

## Clone

```bash
git clone --recurse-submodules https://github.com/linga009/DDC.git
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init
```

## Download the test model

```bash
./scripts/download_test_model.sh
```

This downloads a small TinyLlama GGUF model into `models/` for use by the
test suite and the `swarm-cli` example below.

## Build

```bash
cmake -G Ninja -S . -B build
cmake --build build
```

## Run the tests

```bash
./build/core/tests/inference_engine_test.exe
```

or, from the build directory:

```bash
cd build && ctest
```

## Run swarm-cli

```bash
./build/core/swarm-cli.exe --model models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf "The capital of France is"
```

Example output:

```
The capital of France is Paris.
```

## Coordinator service

`coordinator/` is a small HTTP service that tracks which nodes are alive and
uses their count to gate which models in the catalog are announced as
available. It requires Node.js 22.6+ (native TypeScript support — no build
step, and it has zero npm dependencies).

Run its tests:

```bash
cd coordinator && npm test
```

Start it:

```bash
PORT=8080 node src/main.ts
```

Endpoints:

- `POST /nodes/register` — register a node, returns a `nodeId`
- `POST /nodes/:nodeId/heartbeat` — refresh a node's liveness
- `GET /nodes` — list currently active nodes
- `GET /catalog` — list models with `available` gated on active node count

**Caveat:** there is no authentication, and by default the server binds only
to `127.0.0.1`; setting `HOST` to bind wider (e.g. `0.0.0.0`) should only be
done on trusted networks.
