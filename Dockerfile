# Bud Decision Studio — container image
#
# CPU (default):
#   docker build -t bud-decision-studio .
#   docker run --rm -p 8420:8420 -v bud-data:/data -v bud-models:/models bud-decision-studio
#
# NVIDIA GPU (bake CUDA wheels; needs NVIDIA Container Toolkit at runtime):
#   docker build --build-arg DEVICE=cuda -t bud-decision-studio:cuda .
#   docker run --rm --gpus all -p 8420:8420 -v bud-data:/data -v bud-models:/models bud-decision-studio:cuda
#
# Or: docker compose up --build
# Then open http://127.0.0.1:8420

FROM python:3.12-slim-bookworm

ARG DEVICE=cpu
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DEVICE=${DEVICE} \
    BASAL_HOST=0.0.0.0 \
    BASAL_PORT=8420 \
    BASAL_DATA=/data \
    HF_HOME=/models \
    HF_HUB_CACHE=/models/hub \
    VENV=/opt/bud/.venv \
    PATH=/opt/bud/.venv/bin:/root/.local/bin:$PATH \
    # Seed config for empty /data volume (entrypoint copies this if needed)
    BUD_CONFIG_SEED=/opt/bud/config.seed.json

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl \
      libsndfile1 ffmpeg libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# Same package manager as ./install.sh
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

WORKDIR /app

# Dependency manifests first for better layer caching
COPY requirements.txt requirements-nodeps.txt requirements-cuda.txt ./
COPY docker/install.sh docker/entrypoint.sh ./docker/
RUN chmod +x docker/install.sh docker/entrypoint.sh

COPY basal ./basal
COPY ui ./ui
COPY installer ./installer
COPY run.sh ./

# Install into /opt/bud/.venv; keep a seed config outside the runtime /data volume.
RUN DEVICE="$DEVICE" VENV="$VENV" BASAL_DATA=/opt/bud \
    bash docker/install.sh \
 && cp /opt/bud/config.json /opt/bud/config.seed.json

VOLUME ["/data", "/models"]
EXPOSE 8420

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["python", "-m", "basal.server", "--host", "0.0.0.0", "--port", "8420"]
