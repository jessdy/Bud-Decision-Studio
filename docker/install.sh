#!/usr/bin/env bash
# Non-interactive install for Docker images. DEVICE=cpu|cuda (default cpu).
# Unlike ./install.sh, CUDA can be baked in without a GPU present at build time.
set -euo pipefail
cd "$(dirname "$0")/.."

DEVICE="${DEVICE:-cpu}"
TORCH="${TORCH_VERSION:-2.11.0}"
TORCHVISION="${TORCHVISION_VERSION:-0.26.0}"
VENV="${VENV:-/opt/bud/.venv}"
DATA="${BASAL_DATA:-/data}"

case "$DEVICE" in
  cpu)  TORCH_INDEX="https://download.pytorch.org/whl/cpu" ;;
  cuda) TORCH_INDEX="https://download.pytorch.org/whl/cu126" ;;
  *)    echo "DEVICE must be cpu or cuda (got: $DEVICE)" >&2; exit 1 ;;
esac

if ! command -v uv >/dev/null; then
  echo "uv is required" >&2
  exit 1
fi

mkdir -p "$DATA" "$(dirname "$VENV")"
if [ ! -x "$VENV/bin/python" ]; then
  uv venv "$VENV" --python 3.12 --seed
fi

UVPIP=(uv pip install --python "$VENV/bin/python")
IDX=(--index-url "$TORCH_INDEX" --extra-index-url https://pypi.org/simple --index-strategy unsafe-best-match)

echo "==> PyTorch $TORCH ($DEVICE)"
"${UVPIP[@]}" "torch==$TORCH" "torchvision==$TORCHVISION" "${IDX[@]}"

echo "==> Model libraries"
REQS=(-r requirements.txt)
if [ "$DEVICE" = "cuda" ] && [ -f requirements-cuda.txt ]; then
  REQS+=(-r requirements-cuda.txt)
fi
# Keep the torch build pinned in the same install.
TORCH_PIN="$("$VENV/bin/python" -c 'import torch; print(torch.__version__.split("+")[0])')"
KEEP=("torch==$TORCH_PIN")
if ! "${UVPIP[@]}" "${KEEP[@]}" "${REQS[@]}" "${IDX[@]}"; then
  if [ "$DEVICE" = "cuda" ]; then
    echo "Optional CUDA extras failed; continuing without them."
    "${UVPIP[@]}" "${KEEP[@]}" -r requirements.txt "${IDX[@]}"
  else
    exit 1
  fi
fi

echo "==> Model packages (no-deps)"
"${UVPIP[@]}" --no-deps -r requirements-nodeps.txt

echo "==> Writing $DATA/config.json"
"$VENV/bin/python" - <<PY
import json, platform
from pathlib import Path
data = Path(${DATA@Q})
data.mkdir(parents=True, exist_ok=True)
import torch
dev = ${DEVICE@Q}
ok = {"cuda": torch.cuda.is_available(), "cpu": True}.get(dev, True)
cfg = {
    "device": "cuda" if dev == "cuda" else "cpu",
    "backend": "cuda" if dev == "cuda" else "cpu",
    "device_name": "NVIDIA GPU (Docker)" if dev == "cuda" else "CPU (Docker)",
    "memory_gb": None,
    "unified_memory": False,
    "accelerators": [
        {"id": "cpu", "backend": "cpu", "kind": "cpu", "name": platform.processor() or "CPU"},
        *([{"id": "cuda", "backend": "cuda", "kind": "nvidia", "name": "NVIDIA GPU (Docker)", "cuda": "12.6"}] if dev == "cuda" else []),
    ],
    "torch": torch.__version__,
    "python": str(Path(${VENV@Q}) / "bin" / "python"),
    "os": platform.system().lower(),
    "arch": platform.machine(),
    "installed": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
    "docker": True,
}
(data / "config.json").write_text(json.dumps(cfg, indent=2) + "\n")
print("config ok; torch", torch.__version__, "cuda_available=", torch.cuda.is_available())
PY

echo "Done. Start with: $VENV/bin/python -m basal.server --host 0.0.0.0 --port 8420"
