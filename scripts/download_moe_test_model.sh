#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/models"
MODEL_FILE="$MODEL_DIR/tiny-moe.Q4_K_M.gguf"
MODEL_URL="https://huggingface.co/mradermacher/Tiny-Moe-GGUF/resolve/main/Tiny-Moe.Q4_K_M.gguf"
MODEL_SHA256="c70f8bce32ee5fba3c78e176313579dc21f68ef5c4379929e06f521be9c70cb2"

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

echo "Downloading Tiny-Moe test model (~90MB) to $MODEL_FILE"
curl -fL --retry 3 -o "$MODEL_FILE.part" "$MODEL_URL"

ACTUAL_SHA256="$($SHA256_CMD "$MODEL_FILE.part" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$MODEL_SHA256" ]; then
    echo "ERROR: downloaded file checksum mismatch (expected $MODEL_SHA256, got $ACTUAL_SHA256)" >&2
    rm -f "$MODEL_FILE.part"
    exit 1
fi

mv "$MODEL_FILE.part" "$MODEL_FILE"
echo "Done."
