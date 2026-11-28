import { useEffect, useState } from "react"
import { Navigate, Outlet } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { Loader2, Search } from "lucide-react"

import { AiAssistDockPanel, AiAssistDockProvider, AiAssistToggle } from "../ai-assist/dock"
import { goToSignIn, useAuthStatus, type AuthUser } from "../auth/api"
import { UserMenu } from "../auth/user-menu"
import { ProductIcon } from "../components/product-icon"
import { ProductShell } from "../layout/product-shell"
import { product } from "../lib/products"
import { CommandPalette, type Command } from "./command-palette"
import { ErrorAlert } from "./error-alert"
import { UNAUTHORIZED_EVENT } from "./request"
import { GROUPS, productScreens, type Screen } from "./screens"
import { SectionsProvider, useTabs, visibleSections } from "./sections"

/** A product's own search commands (its pipelines, tables, ...) and their groups, in order. */
/** The products that use ProductApp (the portal has its own page). */
export type ProductAppId = "ingestiq" | "insightiq" | "settings"

export type UseCommands = (
  sections: Screen[],
  user: AuthUser | null,
) => { commands: Command[]; groups: string[]; loading: boolean }

/**
 * The root route of every product (IngestIQ, InsightIQ, Settings & Management): sends a signed-out user to the portal,
 * then shows the product in ProductShell with the user's tabs, search (Ctrl/Cmd+K), the AI Assist
 * panel, the user menu and the product switcher. A product passes its id and its search commands.
 */
export function ProductApp({
  productId,
  useCommands,
  alwaysHome = [],
}: {
  productId: ProductAppId
  useCommands: UseCommands
  /** tabs that always open their start page instead of the page they were last on */
  alwaysHome?: string[]
}) {
  const qc = useQueryClient()
  const auth = useAuthStatus()

  // any API call answering 401: the session ended, so check again (then sign in on the portal)
  useEffect(() => {
    const onUnauthorized = () => void qc.invalidateQueries({ queryKey: ["auth"] })
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [qc])

  if (auth.isLoading) return <Spinner />
  if (auth.error || !auth.data)
    return (
      <div className="mx-auto max-w-lg p-6">
        <ErrorAlert title="Prooflix server is not reachable" error={auth.error ?? new Error("no answer")} />
      </div>
    )
  const { enabled, user, products } = auth.data
  if (enabled && !user) return <SignInRedirect />
  // a product without tabs yet (InsightIQ while it is being built): its frame and a placeholder
  if (productScreens(productId).length === 0)
    return <UnderDevelopment productId={productId} user={enabled ? user : null} products={products} />
  return (
    <Shell
      productId={productId}
      sections={visibleSections(productScreens(productId), enabled && user ? user.visible_tabs : null)}
      user={enabled ? user : null}
      products={enabled && user ? user.visible_products : products}
      useCommands={useCommands}
      alwaysHome={alwaysHome}
    />
  )
}

/** The frame of a product that has no tabs yet, with a note that it is being built. */
function UnderDevelopment({
  productId,
  user,
  products,
}: {
  productId: ProductAppId
  user: AuthUser | null
  products: string[]
}) {
  const name = product(productId).name
  return (
    <ProductShell
      productId={productId}
      groups={[]}
      items={[]}
      onSelect={() => {}}
      products={user ? user.visible_products : products}
      actions={user && <UserMenu user={user} />}
    >
      <div className="mx-auto grid max-w-lg justify-items-center gap-3 py-16 text-center">
        <ProductIcon id={productId} size={56} />
        <h1 className="text-xl font-semibold">{name} is coming soon</h1>
        <p className="text-muted-foreground text-sm">
          This product is being built. Its screens will appear here as they are added.
        </p>
        <a href="/" className="text-sm underline">
          Back to all products
        </a>
      </div>
    </ProductShell>
  )
}

function Spinner() {
  return (
    <div className="flex min-h-svh items-center justify-center">
      <Loader2 className="text-muted-foreground size-6 animate-spin" />
    </div>
  )
}

/** The portal signs users in (and creates the first admin). */
function SignInRedirect() {
  useEffect(goToSignIn, [])
  return <Spinner />
}

function Shell({
  productId,
  sections,
  user,
  products,
  useCommands,
  alwaysHome,
}: {
  productId: ProductAppId
  sections: Screen[]
  user: AuthUser | null
  products: string[]
  useCommands: UseCommands
  alwaysHome: string[]
}) {
  const tabs = useTabs(sections, `prooflix-tab-paths-${productId}`, alwaysHome)
  const [paletteOpen, setPaletteOpen] = useState(false)

  // Ctrl+K / Cmd+K opens the command palette from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <SectionsProvider productId={productId} sections={sections}>
      <AiAssistDockProvider>
        <ProductShell
          productId={productId}
          groups={GROUPS[productId]}
          items={sections}
          active={tabs.active}
          onSelect={tabs.select}
          products={products}
          actions={
            <>
              <AiAssistToggle />
              <SearchButton onClick={() => setPaletteOpen(true)} />
              {user && <UserMenu user={user} />}
            </>
          }
          aside={<AiAssistDockPanel />}
        >
          {sections.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No tabs of this product have been given to your account. Ask an admin to choose the tabs you can see.
            </p>
          ) : tabs.active && sections.some((s) => s.id === tabs.active) ? (
            <Outlet />
          ) : (
            // the start page is the first tab the user has
            <Navigate to={sections[0].home} replace />
          )}
        </ProductShell>
        {paletteOpen && (
          <Palette sections={sections} user={user} useCommands={useCommands} onClose={() => setPaletteOpen(false)} />
        )}
      </AiAssistDockProvider>
    </SectionsProvider>
  )
}

/** The palette with the product's commands, fetched only while it is open. */
function Palette({
  sections,
  user,
  useCommands,
  onClose,
}: {
  sections: Screen[]
  user: AuthUser | null
  useCommands: UseCommands
  onClose: () => void
}) {
  const { commands, groups, loading } = useCommands(sections, user)
  return (
    <CommandPalette
      sections={sections}
      user={user}
      commands={commands}
      groups={groups}
      loading={loading}
      onClose={onClose}
    />
  )
}

function SearchButton({ onClick }: { onClick: () => void }) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted-foreground hover:bg-accent hover:text-foreground flex h-8 items-center gap-2 rounded-md border px-2.5 text-sm sm:w-64"
      aria-label="Search and run commands"
    >
      <Search className="size-4" />
      <span className="hidden sm:inline">Search or run a command</span>
      <kbd className="bg-muted ml-auto hidden rounded px-1.5 font-mono text-xs sm:inline">{mac ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  )
}
