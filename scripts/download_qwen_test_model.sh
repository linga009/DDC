#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/models"
MODEL_FILE="$MODEL_DIR/qwen2.5-0.5b-instruct-q4_k_m.gguf"
MODEL_URL="https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"
MODEL_SHA256="74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db"

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

echo "Downloading Qwen2.5-0.5B-Instruct test model (~490MB) to $MODEL_FILE"
curl -fL -C - --retry 5 --retry-delay 3 -o "$MODEL_FILE.part" "$MODEL_URL"

ACTUAL_SHA256="$($SHA256_CMD "$MODEL_FILE.part" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$MODEL_SHA256" ]; then
    echo "ERROR: downloaded file checksum mismatch (expected $MODEL_SHA256, got $ACTUAL_SHA256)" >&2
    rm -f "$MODEL_FILE.part"
    exit 1
fi

mv "$MODEL_FILE.part" "$MODEL_FILE"
echo "Done."
