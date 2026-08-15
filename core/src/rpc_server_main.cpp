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
    std::printf("swarm-rpc-server starting on %s\n", endpoint.c_str());
    std::printf("warning: the RPC backend is insecure and intended for trusted LAN or "
                "same-host use only -- never expose it to an untrusted network\n");
    std::fflush(stdout);

    ggml_backend_dev_t devices[] = { cpu_dev };
    ggml_backend_rpc_start_server(endpoint.c_str(), /*cache_dir=*/nullptr,
                                   /*n_threads=*/4, /*n_devices=*/1, devices);
    // ggml_backend_rpc_start_server normally blocks forever serving requests.
    // If it returns at all, something went wrong during startup (e.g. the
    // port was already in use) -- there is no successful-and-returned case.
    std::fprintf(stderr, "error: RPC server stopped unexpectedly (port %d in use?)\n", port);
    return 1;
}
