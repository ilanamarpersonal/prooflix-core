# Architecture principles

The rules every change to Prooflix is reviewed against (by the `architect` agent in
`.claude/agents/architect.md`, and by people). Each one is a decision already made;
changing one is fine, but on purpose: update this file in the same change and say why.

## Layers and responsibilities

1. **Prooflix orchestrates; Spark executes.** The server decides what runs, when and
   in which order (DAG, retries, cron, runs, logs). Data work happens inside tasks,
   in Spark. The server never reads or writes lake data in a pipeline's place.
2. **Platform and workspace stay apart.** `prooflix-core` is the platform (server,
   client, Helm, Terraform) and knows nothing about banking tables, schemas or
   business logic. Pipelines, task code, seeds and data generators live in the
   workspace (`prooflix-assets-bundle/workspace/<project>`). The only fixed contract
   between them is a task entrypoint plus `ctx` (`TaskContext`).
3. **Delta in Unity Catalog through Spark is the storage of record.** Bronze, silver
   and gold are external Delta tables registered in Unity Catalog, written by Spark.
   DuckDB in the server reads them only for the SQL Editor, Catalog, ClickHouse
   copies and InsightIQ's ontology (object views, `ontology.py`), at their current
   version (`delta_log.py`), and never writes them. Changes made by the object model's
   actions are rows in its PostgreSQL database (`ontology_store.py`), laid over the
   objects when they are read, never writes to the lake. The fast-search indexes are copies
   in OpenSearch (`search_index.py`), built by reading the lake the same way. The one
   exception is the Catalog's **Drop schema → Delete permanently** (admins only when
   users are on): on an explicit request it deletes the schema's table folders; Unity
   Catalog registrations are left for Spark to drop.
4. **The GUI configures; generated files are an output.** What a tab manages
   (ingestion jobs, schedules, parameters) is configured there and saved as plain
   files (pipeline YAML, JSON in `PROOFLIX_HOME`) that stay readable and
   version-controllable. A generated file says so in its header.
5. **One active workspace, rebuilt on switch or restart.** Workspace-bound services
   are built together in `runtime.py` and swapped as a set; routes read
   `app.state` on every request. Nothing caches a service across a switch.

## Security

6. **No secrets in the workspace or in git.** Passwords and keys live in
   `PROOFLIX_HOME` files with mode 600 (`connections.json`, `users.json`,
   `session.key`), environment variables, or Kubernetes Secrets. Pipeline YAML refers
   to them by name (`connection: bankdb`), and tasks fetch them at run time
   (`ctx.connection`). APIs return secrets masked (`********`), and error messages
   never include them.
7. **Passwords are hashed** (salted scrypt) and never stored, logged or returned.
   The policy (8+ characters, a capital letter, a digit) is enforced by the server;
   the client only previews it.
8. **The server enforces access; the UI only hides.** With `PROOFLIX_AUTH` on, every
   `/api` route needs a session, and each path belongs to the tabs that use it
   (`TAB_PATHS` in `auth.py`). A new API route must be added there, or it is admin
   only. Sessions are HttpOnly, SameSite=Lax cookies that end when the password
   changes or the user is disabled. One session covers every product: the portal signs
   users in, and a user can open a product when they have one of its tabs
   (`PRODUCT_TABS`), so product access never needs a second check.
9. **Least privilege towards other systems.** Read-only database users for
   ingestion, a read-only ClickHouse user for outside queries, internal services
   not exposed by default.
10. **Safety switches can't be turned off from the UI**, for example `PROOFLIX_AUTH`.
11. **Fail closed on security state.** If a security file in `PROOFLIX_HOME`
    (`users.json`, `session.key`, `connections.json`) exists but can't be read or
    parsed, the server refuses the request. It never treats the file as empty, and
    never writes over a file it failed to read.
12. **Read-modify-write under one lock.** Every change to a `PROOFLIX_HOME` JSON file
    happens under its store's lock, from the read to the atomic rename; a record read
    outside the lock is never written back.
13. **Session cookies are `Secure` behind TLS.** The server trusts `X-Forwarded-Proto`
    only from the ingress (`FORWARDED_ALLOW_IPS`, set by the Helm chart).
14. **Code execution is an admin power.** Python tasks only call functions defined in
    the workspace's `src/`, never the standard library or packages. Only admins save
    pipelines with shell tasks. The Workspace tab (it changes code) and the System tab
    (it changes configuration) are as powerful as an admin, and the Users tab says so.
    An entrypoint is checked against `src/` before anything is imported. Values reach
    shell commands as environment variables, never as code, and task folder parameters
    stay inside the workspace. File routes (workspace files, imports, linked folders)
    never reach a path inside or above `PROOFLIX_HOME`; a route changes a
    `PROOFLIX_HOME` file only through that file's store, which follows 11 and 12.
    Connection hosts and database names can't carry JDBC URL options.

## Data and pipelines

15. **Ingestion is idempotent.** Re-running a job or a date range never duplicates
    rows: key columns merge (Delta MERGE), ranges replace exactly their range,
    streams use checkpoints, full copies overwrite.
16. **Times are UTC end to end:** the Spark session time zone, the JVM time zone
    (`-Duser.timezone=UTC`), epoch milliseconds in raw files, and ISO 8601 with an
    offset in APIs.
17. **The system start date** (`PROOFLIX_START_DATE`) is where a first run starts
    when nothing more specific is given. It reaches tasks as `ctx.start_date` and
    `${system.start_date}`.
18. **Swaps are atomic:** a ClickHouse copy loads a staging table and swaps it in
    (`EXCHANGE TABLES`); files are written to a temporary file and renamed.

## Code and API

19. **REST stays plain:** JSON in and out, `4xx` with a readable `detail`,
    `422` for invalid input, `409` for conflicts, `202` for started runs. Errors
    shown to users say what to do next.
20. **Blocking work stays off the event loop.** Database, Spark and file work run in
    threads (`asyncio.to_thread`, sync FastAPI routes); anything that starts a run
    (`executor.start`) runs on the loop (`async def`).
21. **Dependencies are few and free.** Prefer the standard library and existing
    dependencies; any new one must be free for commercial use (check the license),
    pure Python where possible, and pinned. Spark packages are listed in one place
    per layer (`infra/config.py`, the `Dockerfile` `SPARK_PACKAGES`, Helm values) and
    kept in sync.
22. **Everything installable is in the Helm chart and the image** (Java, Spark
    packages, JDBC drivers, Unity Catalog, ClickHouse); a pod starts without
    downloading anything.
23. **Tests and docs change with the code.** Every API route has tests (sign-in on
    and off where it matters); `README.md`, `docs/server.md` (routes and
    configuration), `docs/client.md` (screens) and this file are updated in the same
    change. Every `PROOFLIX_*` parameter appears in the System tab and in the docs.
24. **The client follows the existing patterns:** shadcn/ui components from
    `@prooflix/ui`, TanStack Query hooks in `lib/api.ts`, types in `lib/types.ts`, sections in `lib/tabs.ts`,
    no semicolons, 120-character lines, light and dark themes, usable at narrow widths.
25. **Every product looks the same: one UI package.** The portal, IngestIQ and InsightIQ
    build their screens from `packages/ui` (`@prooflix/ui`): the theme tokens
    (`styles.css`), the shadcn/ui primitives, `IconTile`, the theme switch and
    `ProductShell` (top bar with the Prooflix logo and the product's name, grouped side
    menu, theme switch). A product passes its menu and top-bar actions to `ProductShell`
    and never builds its own frame, copies a primitive or redefines a theme token. A
    new shared component goes into the package, not into one product. Product names and
    colours come from `PRODUCTS` in `lib/products.ts`; every tab, with its product, icon and
    colour, from `SCREENS` in `app/screens.ts`. IngestIQ and InsightIQ use `ProductApp` as
    their root route (sign-in check, frame, search, AI Assist), adding only their routes and
    search commands.
