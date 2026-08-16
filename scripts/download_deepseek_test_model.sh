#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/models"
MODEL_FILE="$MODEL_DIR/DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf"
MODEL_URL="https://huggingface.co/unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf"
MODEL_SHA256="f3bdf9cf31dee4b57ae4e455a1cb0d01b5c2c1b50d72d3112141c195506c2840"

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

echo "Downloading DeepSeek-R1-Distill-Qwen-1.5B test model (~1.1GB) to $MODEL_FILE"
# -C - (resume) matters here: this file has been observed to have its
# connection dropped mid-transfer on a slow/flaky link without curl
# reporting a failure, silently leaving a truncated file that still parses
# as a valid GGUF header but fails to load ("tensor data is not within the
# file bounds") -- resuming plus a checksum check catches this rather than
# leaving a corrupt file that looks downloaded.
curl -fL -C - --retry 8 --retry-delay 3 --retry-all-errors -o "$MODEL_FILE.part" "$MODEL_URL"

ACTUAL_SHA256="$($SHA256_CMD "$MODEL_FILE.part" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$MODEL_SHA256" ]; then
    echo "ERROR: downloaded file checksum mismatch (expected $MODEL_SHA256, got $ACTUAL_SHA256)" >&2
    rm -f "$MODEL_FILE.part"
    exit 1
fi

mv "$MODEL_FILE.part" "$MODEL_FILE"
echo "Done."
