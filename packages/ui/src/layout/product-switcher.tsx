import { useEffect, useRef, useState } from "react"
import { Check, LayoutGrid } from "lucide-react"

import { ProductIcon } from "../components/product-icon"
import { Button } from "../components/ui/button"
import { PRODUCTS, type Product } from "../lib/products"
import { cn } from "../lib/utils"

/**
 * The products menu in the top bar: the portal and every product this user can open, the
 * current one ticked. Products the user can't open aren't listed.
 */
export function ProductSwitcher({ current, products }: { current: Product["id"]; products: string[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const items = PRODUCTS.filter((p) => p.id === "portal" || products.includes(p.id))

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    document.addEventListener("mousedown", close)
    document.addEventListener("keydown", esc)
    return () => {
      document.removeEventListener("mousedown", close)
      document.removeEventListener("keydown", esc)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Switch product"
        title="Switch product"
      >
        <LayoutGrid />
      </Button>
      {open && (
        <div
          role="menu"
          className="bg-popover text-popover-foreground absolute right-0 z-50 mt-1 w-64 rounded-md border p-1 shadow-md"
        >
          {items.map((p) => (
            <a
              key={p.id}
              role="menuitem"
              href={p.path}
              aria-current={p.id === current ? "page" : undefined}
              className={cn(
                "hover:bg-accent flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm",
                p.id === current && "font-medium",
              )}
            >
              <ProductIcon id={p.id} size={22} />
              <span className="flex-1">{p.id === "portal" ? "All products" : p.name}</span>
              {p.id === current && <Check className="size-4" />}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
