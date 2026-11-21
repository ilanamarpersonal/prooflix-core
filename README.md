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

Pipelines whose code runs on Spark need the `spark` extra and Java 17 (for
example `brew install openjdk@17`): `uv run --extra spark prooflix serve --reload`.
The Docker image has both.

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

A workspace has two data folders, and either can live elsewhere and be used in
place (select the workspace's top folder, then **Change**):

- **Source data folder** (`source/`): the raw files pipelines read, never written
  to. Server default `PROOFLIX_SOURCE_DATA` (Helm `sourceData`).
- **Data lake folder** (`data/`): what pipelines build, `data/<catalog>/<schema>/<table>/`
  (bronze, gold) and their checkpoints (`data/<catalog>/checkpoint/`); the catalog
  and SQL editor read it. Server default `PROOFLIX_DATA_LAKE` (Helm `dataLake`).

## Add pipelines

A new workspace starts empty. Write pipelines in it, or open
**Workspace → Import Workspace** and choose a folder on your computer that has
`pipelines/*.yaml` and its Python code in `src/`. It is copied into
`workspaces/` as a new workspace and made active, and its pipelines appear in the
**Pipelines** tab, where **Run** starts them and clicking a task shows what it
printed.

## Catalog

The **Catalog** tab lists schemas and their tables, which you can query in the
**SQL Editor** as `schema.table`. A schema is either a project's `data/` folder
in the workspace, or a folder in `catalog/` (next to `workspaces/`, set with
`PROOFLIX_CATALOG`) for datasets that are not part of a project. **Import**
adds CSV or JSON files as tables; **Export** downloads a table as CSV, or as a
ZIP with a Parquet file, and a schema or the whole catalog as a ZIP.

## System parameters

The **System** tab lists every server setting (`PROOFLIX_*`) with the value in
use, its default and where it comes from. The pencil edits a value: a folder
browser for folders, a date picker for the start date, a text box otherwise.
Edited values are saved to `~/.prooflix/parameters.json`, win over environment
variables (and Helm values), and are applied by **Restart server** (refused
while runs are going).

| Parameter | Default | What it does |
|---|---|---|
| `PROOFLIX_WORKSPACES` | `workspaces/` in this repository | Folder of workspaces |
| `PROOFLIX_WORKSPACE` | the first workspace | Default workspace, until another is made active |
| `PROOFLIX_MAX_DEPTH` | `10` | Maximum sub-pipeline nesting depth |
| `PROOFLIX_CORS` | `http://localhost:5173,http://127.0.0.1:5173` | Browser origins allowed to call the API (needs a process restart) |
| `PROOFLIX_CATALOG` | `catalog/` next to the workspaces folder | Catalog schemas that are not part of a project |
| `PROOFLIX_SCHEDULER` | on | Run pipelines on their cron schedules |
| `PROOFLIX_AUTH` | on | Users and the login page; `0` turns them off. Environment variable only |
| `PROOFLIX_START_DATE` | unset (all data) | Where data processing starts when the system is initialized: a pipeline with no checkpoint yet processes data from this date on (`ctx.start_date` in Python, `${system.start_date}` in YAML) |
| `PROOFLIX_HOME` | `~/.prooflix` | Server-wide state; environment variable only |
| `PROOFLIX_SOURCE_DATA` | each workspace's `source/` | Default source data folder |
| `PROOFLIX_DATA_LAKE` | each workspace's `data/` | Default data lake folder |

The full reference is in [docs/server.md](docs/server.md#configuration).

## Users and sign-in

Prooflix asks everyone to sign in. On the first start, the login page creates the
first **admin** (there is no default account). In the **Users** tab, admins add
users and choose for each one:

* **Role:** an admin sees every tab and manages users; a user sees only their tabs.
* **Tabs:** which of Pipelines, Ingestion, SQL Editor, Catalog, Workspace,
  ClickHouse and System the user sees. The server enforces it too: a user can't
  call the API of a tab they don't have. Workspace (it changes the code pipelines
  run) and System (it changes the server's configuration) are as powerful as an
  admin, so give them only to trusted people; only admins save pipelines with shell
  tasks.
* **Password:** at least 8 characters with a capital letter and a number. Admins
  can set a new one; everyone can change their own from the user menu (top right).
  Disabling a user, or changing their password, signs them out.

Users live in `PROOFLIX_HOME/users.json`, with salted scrypt password hashes (never
the passwords). `PROOFLIX_AUTH=0` turns sign-in off, for example on a laptop.

## Semantic model

The **Semantic model** tab puts business meaning on top of the catalog's tables, and
saves it in the workspace as `semantic/model.yaml` (so it is versioned with it):

* **Entities:** a catalog table (such as `tenant1.silver.transactions`) with its
  **dimensions** (what to group or filter by: a column or a SQL expression),
  **measures** (sum, count, count distinct, average, min, max of a column or
  expression) and **joins** to other entities.
* **Metrics:** formulas over measures, such as
  `{accounts.total_balance} / NULLIF({accounts.count}, 0)`.
* **Check against the catalog** runs every table, column and expression and lists
  what doesn't work.
* **Explore:** pick measures and dimensions and run them; the model writes the SQL
  (joins included), shows it, and can open it in the SQL Editor.

The vanilla workspace comes with a starter banking model (transactions, accounts,
customers, transaction types).

## Alerts

The **Alerts** tab raises an alert when a task's log shows a line in a format you
define, and sends it to **Email**, **Slack**, **Microsoft Teams** or a **webhook**:

* **Rules:** a log message format such as `ERROR {message}` (failed tasks) or
  `ALERT {severity}: {message}` (a task can print its own alerts), where `{name}`
  matches any text and becomes a field of the alert; or a regular expression. A rule
  watches all pipelines or chosen ones, sends to all channels or chosen ones, has a
  severity, and a cooldown so a noisy line notifies at most once per pipeline in that
  time. "Try a log line" shows whether a line would raise the alert.
* **Channels:** an SMTP server and recipients, a Slack incoming webhook, a Teams
  workflow webhook, or any HTTP endpoint (the alert as JSON). **Test** sends a test
  alert. URLs and passwords are kept in `PROOFLIX_HOME/alerts.json` (mode 600).
* **Recent alerts** shows each alert and whether every channel received it.

Only admins, and users an admin gives the Alerts permission, can create alerts.

## Ingestion from databases

The **Ingestion** tab copies tables of Oracle, SQL Server, MySQL and PostgreSQL
databases into the bronze layer, all configured in the GUI:

1. **Database connections**: pick the database type, then fill in the fields that
   type needs (Oracle: service name or SID; SQL Server: database and encryption;
   MySQL and PostgreSQL: database), plus host, port, user and password. **Test**
   connects and counts the tables. Connections, passwords included, are kept on
   the server in `PROOFLIX_HOME/connections.json` (mode 600), never in the workspace.
2. **Ingestion jobs**: choose a connection, tick the tables, and for each table the
   columns, the bronze table name and the **watermark**: a date, timestamp or
   increasing integer column (such as `updated_at`). Each run then appends only rows
   whose watermark is above the highest one already in bronze; the first run starts
   from the job's **start date** (else the system start date). A table without a
   watermark is copied whole each run. **Key columns** (by default the source
   table's primary key) make rows that are already in bronze get overwritten by
   their newest version instead of added again (a Delta MERGE). The **trigger** is
   Manual only, a preset (every N minutes, daily, weekly, ...) or a cron expression.
3. **Ingest dates**: run one job, the selected jobs or all of them for the rows
   between two dates (both included). Rows of that range already in bronze are
   overwritten, by key or by replacing the range, so a range can be ingested again
   without duplicates. **Run selected** and **Run all** start several jobs at once.

A job is saved as an ordinary pipeline (`pipelines/<job id>.yaml`, generated by the
tab), so it shows in Pipelines with its runs, can be run now or stopped, and its
schedule runs like any other. Its task, `bronze.jdbc_ingest:run`, reads the
database with Spark over JDBC and writes Delta tables `tenant1.bronze.<table>`.

## ClickHouse

The **ClickHouse** tab copies gold tables (the tables of a `gold` schema, such as
`tenant1.gold.agg_transactions_per_date`) into ClickHouse with the same columns and
types, as `tenant1.agg_transactions_per_date`. People outside Prooflix query them
there with a read-only user (`SELECT` only). The Helm chart runs ClickHouse; see
[docs/deployment.md](docs/deployment.md) for outside access and running it locally.

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
`prooflix.startDate`, `persistence.size`, `ingress`, ...) are in
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
