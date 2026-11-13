# Prooflix in one image: the FastAPI server, which also serves the built React
# client from client/dist. Build from the repository root:
#
#   docker build -t prooflix:dev .
#
# The repository layout is kept under /app (server/ and client/dist/), because
# server/prooflix/config.py finds the client relative to the repository root.

# --- Stage 1: build the React client ------------------------------------------
FROM node:20-slim AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# --- Stage 2: the Python server -----------------------------------------------
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.8 /uv /bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1

WORKDIR /app/server
# Dependencies first, so code changes don't reinstall them
COPY server/pyproject.toml server/uv.lock server/.python-version ./
RUN uv sync --frozen --no-dev --no-install-project
COPY server/prooflix ./prooflix
RUN uv sync --frozen --no-dev

COPY --from=client /app/client/dist /app/client/dist

# Workspace (imported projects + run history) and catalog live under /data,
# which the Helm chart mounts as a persistent volume.
ENV PATH="/app/server/.venv/bin:$PATH" \
    PROOFLIX_WORKSPACE=/data/workspace \
    PROOFLIX_CATALOG=/data/catalog \
    PROOFLIX_HOME=/data/.prooflix

RUN useradd --uid 10001 --create-home prooflix \
    && mkdir -p /data/workspace /data/catalog \
    && chown -R prooflix:prooflix /data
USER 10001

EXPOSE 8000
CMD ["sh", "-c", "mkdir -p \"$PROOFLIX_WORKSPACE\" \"$PROOFLIX_CATALOG\" && exec prooflix serve --host 0.0.0.0 --port 8000"]
