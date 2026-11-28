# syntax=docker/dockerfile:1
# IngestIQ in one image: the FastAPI server, which also serves the built React
# clients: the portal at / (sign-in, product tiles), IngestIQ under /ingestiq/,
# InsightIQ under /insightiq/ and Settings & Management under /settings/. Build from the repository root, which is the context
# (the client uses the shared packages/ui); Dockerfile.dockerignore keeps it small:
#
#   docker build -t prooflix:dev -f products/ingestiq/Dockerfile .
#
# The repository layout is kept under /app (products/ingestiq/server, its client/dist,
# products/portal, products/insightiq and products/settings client/dist), because
# server/prooflix/config.py finds the clients
# relative to the product folder.
#
# Spark is the execution engine of pipeline tasks, so the image also has Java 17
# (Eclipse Temurin, OpenJDK), PySpark (the server's "spark" extra) and the Spark
# packages pipelines use (Delta Lake, the Unity Catalog connector, Avro, and the
# JDBC drivers for Oracle, SQL Server, MySQL and PostgreSQL ingestion), fetched
# at build time so pods start without downloading anything.

# --- Stage 1: build the React client ------------------------------------------
# The npm workspace (root package.json) holds the client and the shared UI package.
FROM node:20-slim AS client
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/ui/package.json packages/ui/
COPY products/ingestiq/client/package.json products/ingestiq/client/
COPY products/portal/client/package.json products/portal/client/
COPY products/insightiq/client/package.json products/insightiq/client/
COPY products/settings/client/package.json products/settings/client/
RUN npm ci --workspace @prooflix/ingestiq-client --workspace @prooflix/portal-client \
    --workspace @prooflix/insightiq-client --workspace @prooflix/settings-client --include-workspace-root
COPY packages/ui/ packages/ui/
COPY products/ingestiq/client/ products/ingestiq/client/
COPY products/portal/client/ products/portal/client/
COPY products/insightiq/client/ products/insightiq/client/
COPY products/settings/client/ products/settings/client/
RUN npm run build --workspace @prooflix/ingestiq-client --workspace @prooflix/portal-client \
    --workspace @prooflix/insightiq-client --workspace @prooflix/settings-client

# --- Stage 2: the Python server -----------------------------------------------
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.8 /uv /bin/uv
# Java for Spark (OpenJDK 17, GPLv2 with the Classpath Exception: free to use)
COPY --from=eclipse-temurin:17-jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk

# Keep in step with workspaces' infra/config.py (the Spark 4.0 line)
ARG SPARK_PACKAGES="io.delta:delta-spark_4.0_2.13:4.3.1,io.unitycatalog:unitycatalog-spark_4.0_2.13:0.7.0,org.apache.spark:spark-avro_2.13:4.0.5,com.oracle.database.jdbc:ojdbc11:23.5.0.24.07,com.microsoft.sqlserver:mssql-jdbc:12.8.1.jre11,com.mysql:mysql-connector-j:9.1.0,org.postgresql:postgresql:42.7.4"

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1

WORKDIR /app/products/ingestiq/server
# Dependencies first, so code changes don't reinstall them
COPY products/ingestiq/server/pyproject.toml products/ingestiq/server/uv.lock products/ingestiq/server/.python-version ./
# uv's download cache is a build cache mount, so it never ends up in the image
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --extra spark --no-install-project
COPY products/ingestiq/server/prooflix ./prooflix
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

COPY --from=client /src/products/ingestiq/client/dist /app/products/ingestiq/client/dist
COPY --from=client /src/products/portal/client/dist /app/products/portal/client/dist
COPY --from=client /src/products/insightiq/client/dist /app/products/insightiq/client/dist
COPY --from=client /src/products/settings/client/dist /app/products/settings/client/dist

# Workspaces (each a folder of pipelines, code and run history) and the catalog
# live under /data, which the Helm chart mounts as a persistent volume.
ENV PATH="/app/products/ingestiq/server/.venv/bin:$JAVA_HOME/bin:$PATH" \
    PROOFLIX_WORKSPACES=/data/workspaces \
    PROOFLIX_CATALOG=/data/catalog \
    PROOFLIX_HOME=/data/.prooflix \
    PROOFLIX_SPARK_PACKAGES=${SPARK_PACKAGES} \
    PROOFLIX_SPARK_IVY=/opt/spark-ivy

USER 10001

EXPOSE 8000
CMD ["sh", "-c", "mkdir -p \"$PROOFLIX_WORKSPACES\" \"$PROOFLIX_CATALOG\" && exec prooflix serve --host 0.0.0.0 --port 8000"]
