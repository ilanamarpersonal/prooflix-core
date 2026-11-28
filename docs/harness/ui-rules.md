# UI rules: every product looks the same

Principle 25 in short: the portal, IngestIQ and InsightIQ are built from one package,
`@prooflix/ui` (`packages/ui`). A user moving between products should see the same frame,
colours, controls and behaviour.

## Must

- **Frame:** wrap the product in `ProductShell` (`@prooflix/ui/layout/product-shell`). Pass
  `productId`, the menu (`groups`, `items`), `active`, `onSelect`, the top-bar `actions` and
  an optional `aside` panel. The shell already provides the logo, the product's name, the side
  menu (collapsible, grouped), the narrow-screen icon bar and the theme switch.
- **Theme:** a product's `src/index.css` contains only these lines, plus product-only
  additions that use the existing tokens:
  ```css
  @import "tailwindcss";
  @import "tw-animate-css";
  @import "@prooflix/ui/styles.css";
  @source "../../../../packages/ui/src";
  ```
- **Primitives:** import from `@prooflix/ui/components/ui/<name>` (button, card, table, tabs,
  input, badge, alert, ...).
- **Menu icons:** use `IconTile` with a colour per tab, as IngestIQ does.
- **Theme switching:** use `ThemeToggle` or `setTheme` (key `prooflix-theme`), so every
  product switches together.
- **Names and colours** of products come from `PRODUCTS` (`@prooflix/ui/lib/products`).
- **Shared look:** light and dark themes, usable at narrow widths, no semicolons,
  120-character lines (principle 24).

- **Busy buttons:** a button that waits on work (saving, checking, publishing) gets
  `loading` (`<Button loading={pending}>`): a spinner in place of its icons, and it can't be
  clicked until the work is done.

## Must not

- Copy a shadcn primitive, the logo or theme tokens into a product.
- Build a product-specific header, side menu or theme toggle.
- Hard-code colours that a token covers (`bg-background`, `text-muted-foreground`,
  `text-status-failed`, ...).
- Add a UI library next to shadcn/ui and Radix.

## Changing the shared look

1. Change it in `packages/ui`. A new primitive goes through `packages/ui/components.json`.
2. Type-check and build every product's client.
3. Check every product in light and dark, wide and narrow.
4. Update the `@prooflix/ui` table in `docs/client.md`.

A component starts in a product when only that product needs it. It moves to `packages/ui`
when a second product needs it, and is never copied.
