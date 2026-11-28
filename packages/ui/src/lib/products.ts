/**
 * The Prooflix products, in the order the portal and the product switcher show them. Every
 * product's shell names itself from this list, so names and colours stay the same everywhere.
 */
export interface Product {
  id: "portal" | "ingestiq" | "insightiq" | "settings"
  name: string
  /** one line for the portal's tile */
  description: string
  /** where the product is served, on the same domain as the portal */
  path: string
  /** the accent of its tile and its name in the top bar */
  color: string
}

export const PRODUCTS: Product[] = [
  {
    id: "portal",
    name: "Prooflix",
    description: "The enterprise portal: every product you have, after sign-in.",
    path: "/",
    color: "#1F2A44",
  },
  {
    id: "ingestiq",
    name: "IngestIQ",
    description: "Ingest data and run the bronze, silver and gold pipelines.",
    path: "/ingestiq/",
    color: "#378ADD",
  },
  {
    id: "insightiq",
    name: "InsightIQ",
    description: "Explore, model and share insights from the data.",
    path: "/insightiq/",
    color: "#7F56D9",
  },
  {
    id: "settings",
    name: "Settings & Management",
    description: "Server settings, users and AI Assist: who can open which products and tabs.",
    path: "/settings/",
    color: "#475569",
  },
]

export function product(id: Product["id"]): Product {
  return PRODUCTS.find((p) => p.id === id)!
}

/** A link to a page of another product: productHref("ingestiq", "/workspace?path=x") -> "/ingestiq/workspace?path=x". */
export function productHref(id: Product["id"], path: string): string {
  return product(id).path + path.replace(/^\//, "")
}
