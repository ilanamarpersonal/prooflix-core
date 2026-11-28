import { useState } from "react"
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from "lucide-react"

import prooflixLogo from "../assets/prooflix-logo.svg"
import prooflixLogoDark from "../assets/prooflix-logo-dark.svg"
import { IconTile } from "../components/icon-tile"
import { ProductIcon } from "../components/product-icon"
import { ThemeToggle } from "../components/theme-toggle"
import { Button } from "../components/ui/button"
import { cn } from "../lib/utils"
import { product, type Product } from "../lib/products"
import { ProductSwitcher } from "./product-switcher"

/** A menu entry of a product: one of its tabs. */
export interface NavItem<Id extends string = string> {
  id: Id
  label: string
  icon: (props: { className?: string }) => React.ReactNode
  /** the menu group it sits in */
  group: string
  /** the colour of its menu tile; none for an icon that is a tile already */
  color?: string
}

export interface NavGroup {
  id: string
  label: string
}

const COLLAPSED_KEY = "prooflix-sidebar-collapsed"
const GROUPS_KEY = "prooflix-menu-closed-groups"

function loadClosedGroups(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]")
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [])
  } catch {
    return new Set()
  }
}

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * The frame every Prooflix product uses, so they all look and behave the same: a full-width top
 * bar (the Prooflix logo, the product's name, its own actions, the product switcher), a grouped side menu
 * that collapses to icons and moves into the top bar on small screens, the theme switch, and the
 * page. A product passes its menu and actions; it doesn't build its own frame.
 */
export function ProductShell<Id extends string>({
  productId,
  groups,
  items,
  active,
  onSelect,
  actions,
  products,
  aside,
  children,
}: {
  productId: Product["id"]
  groups: readonly NavGroup[]
  items: NavItem<Id>[]
  active?: Id
  onSelect: (id: Id) => void
  /** the right side of the top bar (search, the user menu, ...) */
  actions?: React.ReactNode
  /** the products this user can open; shows the product switcher when given */
  products?: string[]
  /** a panel docked to the right of the page */
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const current = product(productId)

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1")
      } catch {
        /* storage unavailable */
      }
      return !c
    })

  return (
    <div className="flex min-h-svh flex-col">
      <header className="bg-background sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <a href="/" className="mr-2 flex shrink-0 items-center gap-2.5" title="Prooflix: all products">
          {/* the wordmark's navy letters, swapped for light ones in dark mode */}
          <img src={prooflixLogo} alt="Prooflix" width={105} height={24} className="h-6 w-auto dark:hidden" />
          <img src={prooflixLogoDark} alt="Prooflix" width={105} height={24} className="hidden h-6 w-auto dark:block" />
          {current.id !== "portal" && (
            <>
              <span className="bg-border h-5 w-px" aria-hidden />
              <ProductIcon id={current.id} size={22} />
              <span
                style={{ "--product": current.color } as React.CSSProperties}
                className="text-sm font-semibold text-[var(--product)] dark:text-[color-mix(in_srgb,var(--product)_65%,white)]"
              >
                {current.name}
              </span>
            </>
          )}
        </a>
        {/* on small screens the menu sits in the top bar, as icons */}
        <nav className="flex items-center gap-0.5 overflow-x-auto md:hidden" aria-label="Sections">
          {items.map(({ id, label, icon, color }) => (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              aria-label={label}
              title={label}
              aria-current={active === id ? "page" : undefined}
              className={cn("rounded-md p-1.5", active === id && "bg-accent")}
            >
              <IconTile icon={icon} color={color} />
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {actions}
          {products && <ProductSwitcher current={productId} products={products} />}
          <div className="md:hidden">
            <ThemeToggle compact />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {items.length > 0 && (
          <aside
            className={cn(
              "bg-sidebar text-sidebar-foreground border-sidebar-border sticky top-14 hidden h-[calc(100svh-3.5rem)] shrink-0 flex-col border-r pt-3 transition-[width] md:flex",
              collapsed ? "w-14" : "w-56",
            )}
          >
            <SideNav groups={groups} items={items} active={active} collapsed={collapsed} onSelect={onSelect} />
            <div className={cn("mt-auto grid gap-1 p-2", collapsed && "justify-items-center")}>
              <ThemeToggle compact={collapsed} />
              <Button
                variant="ghost"
                size={collapsed ? "icon" : "sm"}
                onClick={toggleCollapsed}
                className={collapsed ? "" : "w-full justify-start"}
                aria-label={collapsed ? "Expand the menu" : "Collapse the menu"}
                title={collapsed ? "Expand the menu" : "Collapse the menu"}
              >
                {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
                {!collapsed && "Collapse"}
              </Button>
            </div>
          </aside>
        )}

        <main className="w-full min-w-0 flex-1 p-4 md:p-6">{children}</main>
        {aside}
      </div>
    </div>
  )
}

/** The side menu: items grouped; icons only when collapsed. */
function SideNav<Id extends string>({
  groups,
  items,
  active,
  collapsed,
  onSelect,
}: {
  groups: readonly NavGroup[]
  items: NavItem<Id>[]
  active?: Id
  collapsed: boolean
  onSelect: (id: Id) => void
}) {
  // groups the user closed (all open by default), remembered in the browser
  const [closed, setClosed] = useState<Set<string>>(loadClosedGroups)
  const toggleGroup = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(GROUPS_KEY, JSON.stringify([...next]))
      } catch {
        /* storage unavailable */
      }
      return next
    })
  return (
    <nav className="flex min-h-0 flex-col gap-3 overflow-y-auto px-2" aria-label="Sections">
      {groups.map((g) => {
        const inGroup = items.filter((s) => s.group === g.id)
        if (!inGroup.length) return null
        return (
          <div key={g.id} className="grid gap-0.5">
            {collapsed ? (
              <div className="bg-sidebar-border mx-2 my-1 h-px" aria-hidden />
            ) : (
              <button
                type="button"
                onClick={() => toggleGroup(g.id)}
                aria-expanded={!closed.has(g.id)}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-md px-3 pb-1 text-left text-xs font-medium"
              >
                <ChevronDown className={cn("size-3 transition-transform", closed.has(g.id) && "-rotate-90")} />
                {g.label}
                {closed.has(g.id) && <span className="ml-auto font-normal">{inGroup.length}</span>}
              </button>
            )}
            {/* the icon rail always shows every item; the full menu hides a closed group's items,
                except the page you are on */}
            {inGroup
              .filter((s) => collapsed || !closed.has(g.id) || s.id === active)
              .map(({ id, label, icon, color }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onSelect(id)}
                  title={collapsed ? label : undefined}
                  aria-label={collapsed ? label : undefined}
                  aria-current={active === id ? "page" : undefined}
                  className={cn(
                    "hover:bg-sidebar-accent flex items-center gap-2.5 rounded-md py-1.5 text-left text-sm",
                    collapsed ? "justify-center px-0" : "px-3",
                    active === id && "bg-sidebar-accent font-medium",
                  )}
                >
                  <IconTile icon={icon} color={color} />
                  {!collapsed && label}
                </button>
              ))}
          </div>
        )
      })}
    </nav>
  )
}
