#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/models"
MODEL_FILE="$MODEL_DIR/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf"
MODEL_URL="https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf"
MODEL_SHA256="9fecc3b3cd76bba89d504f29b616eedf7da85b96540e490ca5824d3f7d2776a0"

mkdir -p "$MODEL_DIR"

if [ -f "$MODEL_FILE" ]; then
    echo "Model already downloaded at $MODEL_FILE"
    exit 0
fi

echo "Downloading TinyLlama test model (~669MB) to $MODEL_FILE"
curl -fL --retry 3 -o "$MODEL_FILE.part" "$MODEL_URL"
mv "$MODEL_FILE.part" "$MODEL_FILE"

echo "Verifying checksum..."
ACTUAL_SHA256="$(sha256sum "$MODEL_FILE" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$MODEL_SHA256" ]; then
    echo "ERROR: checksum mismatch for $MODEL_FILE" >&2
    echo "  expected: $MODEL_SHA256" >&2
    echo "  actual:   $ACTUAL_SHA256" >&2
    rm -f "$MODEL_FILE"
    exit 1
fi

echo "Done."
