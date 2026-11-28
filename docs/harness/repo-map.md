# Repository map

`prooflix-core` is a monorepo: one folder per product under `products/`, shared code under
`packages/`, shared deployment under `deploy/`. Pipelines, task code and data are not here:
they live in the workspace repository `../prooflix-assets-bundle` (principle 2).

```text
prooflix-core/
├── CLAUDE.md                    agent entry point
├── package.json                 npm workspaces: packages/* and products/*/client
├── package-lock.json            the one lock file for every client
├── packages/
│   └── ui/                      @prooflix/ui: the shared look (see ui-rules.md)
│       ├── components.json      shadcn/ui config: add new primitives here
│       └── src/
│           ├── styles.css       theme tokens (light/dark), status colours, base styles
│           ├── components/ui/   shadcn/ui primitives
│           ├── components/      icon-tile, theme-toggle, product-icon, resize-divider, error-message
│           ├── layout/          product-shell (the frame of every product), product-switcher
│           ├── app/             product-app (root route), screens (SCREENS, GROUPS), sections, command-palette,
│           │                    error-alert, page-header, request (the API helper)
│           ├── ai-assist/       the AI Assist panel on every screen, its icon and API
│           ├── auth/            sign-in page, user menu, password rules, auth API
│           ├── lib/             products (PRODUCTS, productHref), utils (cn), format, api-error, dom-guard
│           └── assets/          Prooflix logos
├── products/
│   ├── ingestiq/                ingestion and the medallion pipelines (today's app)
│   │   ├── Dockerfile           the image (IngestIQ + portal), built from the repository root
│   │   ├── Dockerfile.dockerignore   allowlist of what the image needs
│   │   ├── server/              FastAPI package "prooflix" (uv), tests in server/tests
│   │   └── client/              React + Vite, served by the server from client/dist
│   ├── portal/client/           the enterprise portal at / : sign-in, product tiles (served by IngestIQ's server)
│   ├── insightiq/client/        InsightIQ at /insightiq/: the Object Model (ontology) and Objects tabs
│   └── settings/client/         Settings & Management at /settings/: System, Users, AI Assist (linked from the portal)
├── deploy/
│   ├── helm/prooflix/           Helm chart
│   └── terraform/               installs the chart
└── docs/                        design documents; harness/ is this guide
```

## Where new code goes

| You are adding | Put it in |
|---|---|
| a screen, route or API for one product | that product's `client/` or `server/` |
| a UI component more than one product could use | `packages/ui` (never copied into a product) |
| a shadcn/ui primitive | `packages/ui/src/components/ui/` via its `components.json` |
| a theme token or colour | `packages/ui/src/styles.css` |
| a product's name, path or colour | `PRODUCTS` in `packages/ui/src/lib/products.ts` |
| a tab (or moving one between products) | `SCREENS` in `packages/ui/src/app/screens.ts`, `PRODUCT_TABS` and `TAB_PATHS` in `auth.py`, `LEGACY_ROUTES` in `main.py` |
| a search command | the product's `lib/commands.ts` |
| a link to another product's page | `productHref(product, path)`, a full page load (router state doesn't cross products) |
| sign-in UI (login, user menu, switcher) | `packages/ui/src/auth/`, `packages/ui/src/layout/` |
| sessions, users, which products a user opens | `products/ingestiq/server/prooflix/auth.py` (`PRODUCT_TABS`); it moves to a shared server package when the products split into services |
| pipelines, task code, seeds | `../prooflix-assets-bundle/workspace/<project>`, not this repository |
| a secret | nowhere in git (principles 6 to 14) |

## Facts that are easy to get wrong

- The server finds its client two folders above its package (`config.py`, `REPO_ROOT`), which
  is the product folder (`products/ingestiq`), or `/app` inside the image.
- `node_modules` lives at the repository root. Never run `npm install` inside a product.
- The client's `@/` alias points at that product's `src/`. Shared code is imported as
  `@prooflix/ui/...`, and files inside `packages/ui` import each other with relative paths.
