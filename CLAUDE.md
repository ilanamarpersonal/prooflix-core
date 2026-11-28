# Prooflix (prooflix-core)

A monorepo with one folder per product under `products/`. Today: `products/ingestiq`
(ingestion and the medallion pipelines: `server/` FastAPI, Python, uv; `client/` React,
shadcn/ui, Vite). `products/portal` (the enterprise portal at `/`: sign-in and product tiles; client only,
served by IngestIQ's server) and `products/insightiq` (data insights at `/insightiq/`: the
Object Model (an ontology) and Objects tabs; see `docs/insightiq-ontology-design.md`) and `products/settings` (Settings & Management at
`/settings/`: System, Users, AI Assist settings). The portal, InsightIQ and Settings are clients only; their API is
in IngestIQ's server. Shared: `packages/ui` (`@prooflix/ui`: theme,
shadcn/ui components, the product shell every product uses), `deploy/` (Helm, Terraform),
`docs/`. Pipelines, task code and data live in the workspace repository `../prooflix-assets-bundle`. Read
`docs/architecture-principles.md` before designing a change.

The agent guides are in `docs/harness/` (start at `docs/harness/README.md`): the
repository map, the change workflow, the UI rules and the new-product checklist.

## Reviews on request

Two reviewer agents are available:

- `architect` (`.claude/agents/architect.md`): design against `docs/architecture-principles.md`.
- `security-reviewer` (`.claude/agents/security-reviewer.md`): vulnerabilities.

Run them only when the user asks for a review (not after every change). When asked:
run both on the change in parallel, fix every `blocker` (architect) and `critical` or
`high` (security) finding, and report the verdicts and remaining findings plainly.

## Working conventions

- After every code change: build the client (`npm --prefix products/ingestiq/client run build`, and
  `npm --prefix products/portal/client run build` / `products/insightiq/client` / `products/settings/client` for those
  products; all four when `packages/ui` changed) when it
  changed, restart the `prooflix-server` preview, and refresh the browser.
- InsightIQ's object model keeps versions, actions' edits and its audit log in PostgreSQL: locally the
  `prooflix-postgres` preview (Docker), set as `PROOFLIX_DATABASE_URL` / `_USER` / `_PASSWORD` in System.
- Tests: `uv run --directory products/ingestiq/server --extra spark pytest -q`; client: `npx tsc -b` in
  `products/ingestiq/client/`.
- npm workspaces: run `npm install` once at the repository root (not in a product).
- Every product's UI is built from `@prooflix/ui` (principle 25): no product-local copies of
  shadcn primitives, theme tokens or its own frame.
- Client style: no semicolons, 120-character lines (`npx prettier --no-semi --print-width 120`).
- Both repositories work on `main` (no feature branches). The bundle pushes over SSH:
  `git push git@github.com:ilanamarpersonal/prooflix-assets-bundle.git main`.
- Secrets never go in the repositories (see principles 6–14).
