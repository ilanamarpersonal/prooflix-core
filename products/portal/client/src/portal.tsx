import { ArrowRight, Loader2 } from "lucide-react"

import { useAuthStatus, type AuthStatus } from "@prooflix/ui/auth/api"
import { LoginPage } from "@prooflix/ui/auth/login-page"
import { UserMenu } from "@prooflix/ui/auth/user-menu"
import { ErrorMessage } from "@prooflix/ui/components/error-message"
import { ProductIcon } from "@prooflix/ui/components/product-icon"
import { Badge } from "@prooflix/ui/components/ui/badge"
import { ProductShell } from "@prooflix/ui/layout/product-shell"
import { PRODUCTS, type Product } from "@prooflix/ui/lib/products"
import { cn } from "@prooflix/ui/lib/utils"

/** The enterprise portal: sign-in, then always Home, with a tile for each product. */
export function Portal() {
  const auth = useAuthStatus()

  if (auth.isLoading)
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </div>
    )
  if (auth.error || !auth.data)
    return (
      <div className="mx-auto max-w-lg p-6">
        <ErrorMessage title="Prooflix server is not reachable" error={auth.error ?? new Error("no answer")} />
      </div>
    )
  const { enabled, setup_needed, user } = auth.data
  if (enabled && !user) return <LoginPage setup={setup_needed} />
  return <Home status={auth.data} />
}

function Home({ status }: { status: AuthStatus }) {
  const user = status.enabled ? status.user : null
  const mine = user ? user.visible_products : status.products

  return (
    <ProductShell
      productId="portal"
      groups={[]}
      items={[]}
      onSelect={() => {}}
      products={mine}
      actions={user && <UserMenu user={user} />}
    >
      <div className="mx-auto grid max-w-5xl gap-6 py-4">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{user ? `Welcome, ${user.username}` : "Welcome"}</h1>
          <p className="text-muted-foreground text-sm">Choose a product to open.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PRODUCTS.filter((p) => p.id !== "portal" && p.id !== "settings").map((p) => (
            <ProductTile
              key={p.id}
              product={p}
              state={!status.products.includes(p.id) ? "soon" : mine.includes(p.id) ? "open" : "no-access"}
            />
          ))}
        </div>
        {/* Settings & Management: server settings and users, for those who have them (admins, the System tab) */}
        {status.products.includes("settings") && mine.includes("settings") && (
          <SettingsLink product={PRODUCTS.find((p) => p.id === "settings")!} />
        )}
        {user && mine.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No products have been given to your account yet. Ask an admin to choose the tabs you can see.
          </p>
        )}
      </div>
    </ProductShell>
  )
}

/** A product's tile: a link when the user can open it; otherwise why not. */
function ProductTile({ product, state }: { product: Product; state: "open" | "soon" | "no-access" }) {
  const open = state === "open"
  const body = (
    <>
      <div className="flex items-center gap-3">
        <ProductIcon id={product.id} size={48} muted={state === "no-access"} />
        <span className="text-base font-semibold">{product.name}</span>
        {state === "soon" && (
          <Badge variant="outline" className="ml-auto">
            Coming soon
          </Badge>
        )}
        {state === "no-access" && (
          <Badge variant="outline" className="ml-auto">
            No access
          </Badge>
        )}
        {open && <ArrowRight className="text-muted-foreground ml-auto size-4" />}
      </div>
      <p className="text-muted-foreground text-sm">{product.description}</p>
    </>
  )
  const tile = "bg-card text-card-foreground grid gap-3 rounded-xl border p-5 shadow-sm"
  return open ? (
    <a href={product.path} className={cn(tile, "hover:border-ring/60 hover:bg-accent/40 transition-colors")}>
      {body}
    </a>
  ) : (
    <div className={cn(tile, "opacity-60")} aria-disabled>
      {body}
    </div>
  )
}

/** The link to Settings & Management under the products: a row, set apart from the product tiles. */
function SettingsLink({ product }: { product: Product }) {
  return (
    <section className="grid gap-2" aria-label="Administration">
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Administration</h2>
      <a
        href={product.path}
        className="bg-card text-card-foreground hover:border-ring/60 hover:bg-accent/40 flex items-center gap-4 rounded-xl border p-4 shadow-sm transition-colors"
      >
        <ProductIcon id={product.id} size={40} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="font-semibold">{product.name}</span>
          <span className="text-muted-foreground text-sm">{product.description}</span>
        </span>
        <ArrowRight className="text-muted-foreground size-4 shrink-0" />
      </a>
    </section>
  )
}
