# Adding a product

The checklist for a new product under `products/` (InsightIQ's first screens, or a later product), so
it fits the monorepo and looks like the others. `products/ingestiq` is the reference
implementation: copy its structure, not its screens.

## 1. Register it

- Add or confirm the entry in `PRODUCTS` (`packages/ui/src/lib/products.ts`): `id`, `name`,
  `description`, `path` (`/<id>/`, or `/` for the portal) and `color`.

## 2. Client (`products/<id>/client`)

- `package.json`: name it `@prooflix/<id>-client` and depend on `"@prooflix/ui": "*"`. The root
  `package.json` already includes `products/*/client`. Run `npm install` at the root.
- `vite.config.ts`: the `@` alias to `./src`. Set `base: "/<id>/"` when the product is served
  under a path.
- `tsconfig*.json`: copy IngestIQ's (strict, `moduleResolution: bundler`, `@/*` paths).
- `index.html`: copy IngestIQ's theme-before-first-paint script, `translate="no"` and the
  favicon.
- `src/index.css`: exactly the shared imports in [ui-rules.md](ui-rules.md).
- `src/main.tsx`: TanStack Query and React Router, as in IngestIQ.
- The root route is `ProductApp` from `@prooflix/ui/app/product-app` with `productId="<id>"` and
  the product's search commands (`lib/commands.ts`, a `UseCommands` hook). It checks sign-in
  (the portal signs everyone in), and draws `ProductShell` with the user's tabs, search, the AI
  Assist panel, the user menu and the product switcher. Add the product's tabs and groups to
  `SCREENS` and `GROUPS` in `packages/ui/src/app/screens.ts` (add the id to `ProductApp`'s
  `productId` type).
- Server: add the product and its tabs to `PRODUCT_TABS` in `auth.py`, so the portal shows its
  tile and the switcher lists it.
- API calls go through TanStack Query hooks in `lib/api.ts`, with types in `lib/types.ts`.

## 3. Server (`products/<id>/server`), when the product has its own

- A uv project with FastAPI, following IngestIQ's layout (`prooflix`-style package, `api/`
  routers, `tests/`).
- Access control: every `/api` route belongs to a tab in `TAB_PATHS`, or is admin only
  (principle 8). The session cookie and users are shared with the other products: don't add a
  second sign-in.
- Plain REST (principle 19), and blocking work off the event loop (principle 20).

## 4. Image and deployment

- `products/<id>/Dockerfile`, built from the repository root:
  `docker build -f products/<id>/Dockerfile .`.
- A `Dockerfile.dockerignore` next to it, listing only that product and `packages/ui`.
- Helm: a deployment and service for the product, and an ingress path (`/<id>/`) on the same
  host as the portal, so the session cookie is shared. Everything installable stays in the image
  (principle 22).
- `.claude/launch.json`: a `<id>-server` (and client) entry on its own port.

## 5. Docs and harness

- `README.md` layout, `docs/architecture.md` tree, `docs/client.md` and `docs/server.md` sections
  for the product.
- `docs/harness/repo-map.md`: move the product from "planned" to its real entry.
- `CLAUDE.md`: list the product and its test and build commands.

## 6. Done means

- The product's client type-checks and builds, and its tests pass.
- Every other product still builds (they share `packages/ui`).
- It opens behind the same sign-in and shows the same frame as IngestIQ, in light and dark,
  wide and narrow.

## Moving a screen between products

The SQL Editor, Catalog, Semantic model and ClickHouse once moved to InsightIQ and back this way. Use `git mv` for the page and the components only it
uses, move its hooks and types from one `lib/api.ts` / `lib/types.ts` to the other, change its
`product` in `SCREENS` and its entry in `PRODUCT_TABS`, and add it to `LEGACY_ROUTES` so old links
redirect. Any component both products still need goes to `packages/ui`. Links to it from the
other product become `productHref` links.
