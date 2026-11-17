# Prooflix (prooflix-core)

The platform: `server/` (FastAPI, Python, uv), `client/` (React, shadcn/ui, Vite),
`deploy/` (Helm, Terraform), `docs/`. Pipelines, task code and data live in the
workspace repository `../prooflix-assets-bundle`. Read
`docs/architecture-principles.md` before designing a change.

## Reviews on every change

Two reviewer agents check all development:

- `architect` (`.claude/agents/architect.md`): design against `docs/architecture-principles.md`.
- `security-reviewer` (`.claude/agents/security-reviewer.md`): vulnerabilities.

After every change that touches code, configuration or deployment, in either
repository, and before reporting the work done or committing it:

1. Run both agents on the change, in parallel (they review the uncommitted work in both
   repositories by default; say so if the change is something else, like a commit range).
2. Fix every `blocker` (architect) and every `critical` or `high` (security) finding,
   then run the agent that raised it again until they are gone.
3. Tell the user the verdicts and the findings left (`major` and below, `medium` and
   below), with what you fixed. Don't hide or soften findings.

Skip the reviews only for changes that are just documentation or wording, and say so.

## Working conventions

- After every code change: build the client (`npm --prefix client run build`) when it
  changed, restart the `prooflix-server` preview, and refresh the browser.
- Tests: `uv run --directory server --extra spark pytest -q`; client: `npx tsc -b` in `client/`.
- Client style: no semicolons, 120-character lines (`npx prettier --no-semi --print-width 120`).
- Both repositories work on `main` (no feature branches). The bundle pushes over SSH:
  `git push git@github.com:ilanamarpersonal/prooflix-assets-bundle.git main`.
- Secrets never go in the repositories (see principles 6–10).
