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
