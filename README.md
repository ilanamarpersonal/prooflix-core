# Prooflix core

A data-platform core in the style of Databricks Workflows. Pipelines are YAML
files in a workspace, executed by a Python server, and managed from a React
(shadcn/ui) web client. A pipeline task can call another pipeline as a
**sub-pipeline**.

```text
server/      Python server (FastAPI) and CLI         → docs/server.md
client/      React + shadcn/ui web client            → docs/client.md
workspaces/  the workspaces, one folder each (pipelines/, src/, projects) → docs/pipelines.md
catalog/     imported datasets, one folder per schema (Parquet tables)
docs/        design documents with diagrams           → docs/README.md
```

## Requirements

- [uv](https://docs.astral.sh/uv/) (it installs the right Python version automatically)
- Node.js 20 or newer, for the client

## Run it

Server (http://127.0.0.1:8000, API docs at `/docs`):

```bash
cd server
uv run prooflix serve --reload
```

Client (http://localhost:5173), in a second terminal:

```bash
cd client
npm install
npm run dev
```

## Workspaces

A workspace is a folder with `pipelines/` and `src/`. Workspaces live in
`workspaces/` in this repository (`PROOFLIX_WORKSPACES`): each sub-folder with a
`pipelines/` folder is one, listed by name. The first one is active until you
choose another; when the folder is empty a `default` workspace is created, so
one is always active.

On the **Workspace** tab, **New workspace** creates a workspace (in
`workspaces/` unless you pick another folder), and **Switch workspace** chooses
which one is active: pipelines, runs and schedules come from the active
workspace, shown in bold in the list on the left. The active choice is saved in
`~/.prooflix/workspaces.json` (`PROOFLIX_HOME`).

## Add pipelines

A new workspace starts empty. Write pipelines in it, or open
**Workspace → Import code** and choose a project folder that has
`pipelines/*.yaml` and its Python code in `src/`. Each imported project lives in
its own folder in the active workspace, and its pipelines appear in the
**Pipelines** tab, where **Run** starts them and clicking a task shows what it
printed.

## Catalog

The **Catalog** tab lists schemas and their tables, which you can query in the
**SQL Editor** as `schema.table`. A schema is either a project's `data/` folder
in the workspace, or a folder in `catalog/` (next to `workspaces/`, set with
`PROOFLIX_CATALOG`) for datasets that are not part of a project. **Import**
adds CSV or JSON files as tables; **Export** downloads a table as CSV, or as a
ZIP with a Parquet file, and a schema or the whole catalog as a ZIP.

## Use it from the command line

```bash
cd server
uv run prooflix validate
uv run prooflix run pipeline1
```

The sample pipelines used by the tests (`daily_orders` and friends) are in
`server/tests/fixtures/sample_workspace/`; point the CLI at them with
`--workspace tests/fixtures/sample_workspace`.

## A pipeline that calls sub-pipelines

```yaml
# <workspace>/pipelines/daily_orders.yaml
parameters:
  run_date: "2026-01-01"
tasks:
  - key: ingest
    type: pipeline
    pipeline: ingest_orders          # <workspace>/pipelines/ingest_orders.yaml
    parameters:
      run_date: ${params.run_date}
  - key: transform
    type: pipeline
    pipeline: transform_orders
    depends_on: [ingest]
    parameters:
      input_path: ${tasks.ingest.output.path}   # output of the sub-pipeline
outputs:
  total_revenue: ${tasks.transform.output.total_revenue}
```

See [docs/pipelines.md](docs/pipelines.md) for the full format.

## Tests

```bash
cd server
uv run pytest
```

## Run on Kubernetes (Helm)

The [Dockerfile](Dockerfile) builds one image: the server, which also serves
the built client on port 8000. The chart in
[deploy/helm/prooflix](deploy/helm/prooflix) runs it as a single pod (run
history and the scheduler live in the server process, so it must not be scaled
up) with the workspace and catalog on a persistent volume at `/data`.

On a local [kind](https://kind.sigs.k8s.io/) cluster:

```bash
docker build -t prooflix:dev .
kind load docker-image prooflix:dev
helm install prooflix deploy/helm/prooflix --set image.tag=dev --set image.pullPolicy=Never
kubectl port-forward svc/prooflix 8000:8000   # then open http://localhost:8000
```

After a code change, rebuild and load the image, then
`kubectl rollout restart deploy/prooflix`. Settings (`prooflix.scheduler`,
`persistence.size`, `ingress`, ...) are in
[values.yaml](deploy/helm/prooflix/values.yaml). The volume is kept on
`helm uninstall`; delete it with `kubectl delete pvc prooflix`.

### With Terraform

[deploy/terraform](deploy/terraform) installs the same chart with the Helm
provider (the image is still built and loaded as above). It targets the
`kind-kind` context by default; copy
[terraform.tfvars.example](deploy/terraform/terraform.tfvars.example) to
`terraform.tfvars` to change that or other settings.

```bash
cd deploy/terraform
terraform init
terraform apply
```

Editing the chart triggers an upgrade on the next `apply`. A code change only
needs a new image: rebuild, load it, and `kubectl rollout restart deploy/prooflix`.
`terraform destroy` removes the release but keeps the volume. State is stored
locally in `terraform.tfstate`, which is not committed.

Prooflix has no login, so don't expose it publicly. Pipeline tasks run inside
the server container, so libraries that imported projects need must be in the
image.
