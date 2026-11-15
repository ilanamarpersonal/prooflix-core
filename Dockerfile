# syntax=docker/dockerfile:1
# Prooflix in one image: the FastAPI server, which also serves the built React
# client from client/dist. Build from the repository root:
#
#   docker build -t prooflix:dev .
#
# The repository layout is kept under /app (server/ and client/dist/), because
# server/prooflix/config.py finds the client relative to the repository root.
#
# Spark is the execution engine of pipeline tasks, so the image also has Java 17
# (Eclipse Temurin, OpenJDK), PySpark (the server's "spark" extra) and the Spark
# packages pipelines use (Delta Lake, the Unity Catalog connector, Avro), fetched
# at build time so pods start without downloading anything.

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
# Java for Spark (OpenJDK 17, GPLv2 with the Classpath Exception: free to use)
COPY --from=eclipse-temurin:17-jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk

# Keep in step with workspaces' infra/config.py (the Spark 4.0 line)
ARG SPARK_PACKAGES="io.delta:delta-spark_4.0_2.13:4.3.1,io.unitycatalog:unitycatalog-spark_4.0_2.13:0.7.0,org.apache.spark:spark-avro_2.13:4.0.5"

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1

WORKDIR /app/server
# Dependencies first, so code changes don't reinstall them
COPY server/pyproject.toml server/uv.lock server/.python-version ./
# uv's download cache is a build cache mount, so it never ends up in the image
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --extra spark --no-install-project
COPY server/prooflix ./prooflix
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --extra spark

# The user the server runs as; it owns the Spark package cache (Ivy writes to it)
RUN useradd --uid 10001 --create-home prooflix \
    && mkdir -p /data/workspaces /data/catalog /opt/spark-ivy \
    && chown -R prooflix:prooflix /data /opt/spark-ivy

# Fetch the Spark packages into /opt/spark-ivy once, so tasks resolve them offline.
# As the server's user, so the files need no chown (which would copy them into a
# second layer).
USER 10001
RUN .venv/bin/python -c "from pyspark.sql import SparkSession; \
SparkSession.builder.master('local[1]').config('spark.jars.packages', '${SPARK_PACKAGES}') \
.config('spark.jars.ivy', '/opt/spark-ivy').getOrCreate().stop()"

COPY --from=client /app/client/dist /app/client/dist

# Workspaces (each a folder of pipelines, code and run history) and the catalog
# live under /data, which the Helm chart mounts as a persistent volume.
ENV PATH="/app/server/.venv/bin:$JAVA_HOME/bin:$PATH" \
    PROOFLIX_WORKSPACES=/data/workspaces \
    PROOFLIX_CATALOG=/data/catalog \
    PROOFLIX_HOME=/data/.prooflix \
    PROOFLIX_SPARK_PACKAGES=${SPARK_PACKAGES} \
    PROOFLIX_SPARK_IVY=/opt/spark-ivy

USER 10001

EXPOSE 8000
CMD ["sh", "-c", "mkdir -p \"$PROOFLIX_WORKSPACES\" \"$PROOFLIX_CATALOG\" && exec prooflix serve --host 0.0.0.0 --port 8000"]
