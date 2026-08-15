# swarm-llm

A native C++ inference engine (`swarm::InferenceEngine`, a wrapper around
[llama.cpp](https://github.com/ggml-org/llama.cpp)) and a `swarm-cli`
command-line executable for running local LLM inference.

This repo implements five foundational plans from the project vision: a
local, single-device inference engine; a first step into multi-node
sharding via a minimal RPC mechanism; a coordinator service that tracks
node liveness and gates model availability by capacity (both described
below); explicit per-layer placement of Mixture-of-Experts tensors across
local and remote devices; and speculative decoding, which verifies several
draft-model-proposed tokens per target-model round-trip
(`InferenceEngine::complete_speculative`, not yet exposed via `swarm-cli`).
Federation across independently-run coordinator instances is not yet
implemented — see
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
./scripts/download_moe_test_model.sh
```

This downloads a small TinyLlama GGUF model into `models/` for use by the
test suite and the `swarm-cli` example below. The second script fetches a
~90MB MoE (mixture-of-experts) model used by the layer-placement tests.

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

## Networking and RPC sharding

This repo includes a first, minimal step toward multi-node inference, built
on llama.cpp's RPC backend:

- **`swarm-rpc-server`** — a small executable (`core/src/rpc_server_main.cpp`)
  that exposes the local CPU device so another process can offload
  computation to it. Run it with `--port N`. It binds to `127.0.0.1` only —
  there is currently no option to bind another interface, so it is reachable
  only from the same machine.
- **`swarm::InferenceEngine`** has a second constructor overload,
  `InferenceEngine(model_path, remote_endpoints)`, that combines the local
  CPU device with one or more remote devices reached via `swarm-rpc-server`
  instances, so model layers can be split across the local machine and
  remote hosts.

> [!WARNING]
> The underlying llama.cpp RPC backend is, in upstream's own words, "in a
> proof-of-concept development stage. As such, the functionality is fragile
> and insecure." **Never run `swarm-rpc-server` on an open or untrusted
> network.** It has no authentication or encryption. It is suitable for
> trusted LAN or same-host use only, and currently binds to `127.0.0.1` for
> exactly this reason.

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
