# Prooflix (prooflix-core)

The platform: `server/` (FastAPI, Python, uv), `client/` (React, shadcn/ui, Vite),
`deploy/` (Helm, Terraform), `docs/`. Pipelines, task code and data live in the
workspace repository `../prooflix-assets-bundle`. Read
`docs/architecture-principles.md` before designing a change.

## Reviews on request

Two reviewer agents are available:

- `architect` (`.claude/agents/architect.md`): design against `docs/architecture-principles.md`.
- `security-reviewer` (`.claude/agents/security-reviewer.md`): vulnerabilities.

Run them only when the user asks for a review (not after every change). When asked:
run both on the change in parallel, fix every `blocker` (architect) and `critical` or
`high` (security) finding, and report the verdicts and remaining findings plainly.

## Working conventions

- After every code change: build the client (`npm --prefix client run build`) when it
  changed, restart the `prooflix-server` preview, and refresh the browser.
- Tests: `uv run --directory server --extra spark pytest -q`; client: `npx tsc -b` in `client/`.
- Client style: no semicolons, 120-character lines (`npx prettier --no-semi --print-width 120`).
- Both repositories work on `main` (no feature branches). The bundle pushes over SSH:
  `git push git@github.com:ilanamarpersonal/prooflix-assets-bundle.git main`.
- Secrets never go in the repositories (see principles 6–14).
