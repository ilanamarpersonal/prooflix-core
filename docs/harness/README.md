# Agent harness

How AI coding agents (Claude Code and its subagents) work in this monorepo. People can
read it too, but it's written as instructions for an agent. `CLAUDE.md` at the repository
root is the entry point and links here.

| Guide | Read it when |
|---|---|
| [repo-map.md](repo-map.md) | you need to know where something lives or where new code goes |
| [workflow.md](workflow.md) | before every change: build, test, restart, format, review, git |
| [ui-rules.md](ui-rules.md) | you touch any client code in any product |
| [new-product.md](new-product.md) | you add a product (the portal, InsightIQ, a later one) or a screen moves between products |

## The pieces of the harness

| File | What it does |
|---|---|
| `CLAUDE.md` | project instructions loaded into every session |
| `docs/architecture-principles.md` | the rules every change is reviewed against; the guides here never override it |
| `.claude/agents/architect.md` | reviewer: design against the principles (only when a review is asked for) |
| `.claude/agents/security-reviewer.md` | reviewer: vulnerabilities (only when a review is asked for) |
| `.claude/launch.json` | dev servers for the preview pane: `prooflix-server` (port 8000), `prooflix-client` (Vite, 5173) |
| `.claude/settings.local.json` | personal settings, not in git |

## Order of authority

1. The user's instructions in the conversation.
2. `CLAUDE.md`.
3. `docs/architecture-principles.md`.
4. These guides. If a guide disagrees with the principles, the principles win: fix the guide in
   the same change.

Keep these guides current: a change that moves folders, adds a product or changes a
command updates the guide that describes it, in the same change.
