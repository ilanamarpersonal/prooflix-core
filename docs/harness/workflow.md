# Workflow

The routine for every change. Commands run from the repository root unless a step says
otherwise.

## 1. Before you start

- Read `docs/architecture-principles.md` when the change is a design change.
- Check `git status`: both repositories work on `main`, and the user may have uncommitted work.
  Don't overwrite or reformat files you weren't asked to touch.

## 2. Make the change

- Code, tests and docs change together (principle 23): `README.md`, `docs/server.md` (routes,
  configuration), `docs/client.md` (screens), the principles, and the guide in `docs/harness/`
  that describes what you changed.
- New API routes go into `TAB_PATHS` in `auth.py`, or they are admin only (principle 8).

## 3. Check it

| What changed | Run |
|---|---|
| server code | `uv run --directory products/ingestiq/server --extra spark pytest -q` |
| client code or `packages/ui` | `cd products/ingestiq/client && npx tsc -b` |
| client code or `packages/ui` | `npm --prefix products/ingestiq/client run build` |
| portal, InsightIQ, Settings or `packages/ui` | `npm --prefix products/<portal|insightiq|settings>/client run build` (and `npx tsc -b` in it) |
| formatting of files you touched | `npx prettier --no-semi --print-width 120 --check <files>` |
| dependencies in any `package.json` | `npm install` at the root, then commit `package-lock.json` |

A change to `packages/ui` affects every product: type-check and build each product's client.

Some files were already unformatted before the monorepo moves. Format only the files you
change.

## 4. Restart and look

After every code change, without being asked:

1. Rebuild the client when client code or `packages/ui` changed.
2. Stop and start the `prooflix-server` preview (`.claude/launch.json`). Always do a full
   restart, even though `--reload` is on.
3. Reload the page in the browser pane and check the console and the server log for errors.

Sign-in is usually on. Don't type the user's password; when a screen behind sign-in needs
checking, say what you couldn't see.

## 5. Reviews

Only when the user asks for one: run the `architect` and `security-reviewer` agents in
parallel on the change. Fix every architect `blocker` and every security `critical` or `high`
finding, then report the verdicts and the findings that remain.

## 6. Git

- Commit or push only when the user asks.
- Both repositories work on `main`.
- The bundle pushes over SSH:
  `git push git@github.com:ilanamarpersonal/prooflix-assets-bundle.git main`.
- Move files with `git mv` so their history is kept.

## 7. Images and the cluster

```bash
docker build -t prooflix:dev -f products/ingestiq/Dockerfile .
```

`notes.txt` has the kind and Helm commands. The build context is the repository root, and
`products/ingestiq/Dockerfile.dockerignore` limits what goes into it.
