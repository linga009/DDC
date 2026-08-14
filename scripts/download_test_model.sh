#!/usr/bin/env bash
set -euo pipefail

if command -v sha256sum >/dev/null 2>&1; then
    SHA256_CMD="sha256sum"
else
    SHA256_CMD="shasum -a 256"
fi

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

echo "Verifying checksum..."
ACTUAL_SHA256="$($SHA256_CMD "$MODEL_FILE.part" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$MODEL_SHA256" ]; then
    echo "ERROR: downloaded file checksum mismatch (expected $MODEL_SHA256, got $ACTUAL_SHA256)" >&2
    rm -f "$MODEL_FILE.part"
    exit 1
fi

mv "$MODEL_FILE.part" "$MODEL_FILE"
echo "Done."
