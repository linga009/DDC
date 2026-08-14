#include "swarm/inference_engine.h"

#include <cstdio>
#include <exception>
#include <string>

int main(int argc, char** argv) {
    std::string model_path;
    std::string prompt = "Hello, my name is";
    int n_predict = 32;

    try {
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

        if (n_predict <= 0) {
            std::fprintf(stderr, "usage: --n-predict must be a positive integer (got %d)\n", n_predict);
            return 1;
        }

        swarm::InferenceEngine engine(model_path);
        std::string result = engine.complete(prompt, n_predict);

        std::printf("%s%s\n", prompt.c_str(), result.c_str());
        return 0;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "error: %s\n", e.what());
        return 1;
    }
}
