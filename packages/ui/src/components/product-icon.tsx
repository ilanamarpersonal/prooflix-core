import { useId } from "react"

import type { Product } from "../lib/products"
import { cn } from "../lib/utils"

/**
 * Each product's icon: a gradient tile with its own drawing, the same everywhere (portal tiles,
 * the product switcher, the top bar). IngestIQ shows data flowing into the bronze, silver and
 * gold layers; InsightIQ a rising chart with a spark; Settings & Management sliders with a person;
 * the portal four tiles.
 */
export function ProductIcon({
  id,
  size = 40,
  muted = false,
  className,
}: {
  id: Product["id"]
  size?: number
  /** greyed out, for a product the user can't open yet */
  muted?: boolean
  className?: string
}) {
  const uid = useId().replace(/:/g, "")
  const [from, to] = GRADIENTS[id]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden
      className={cn("shrink-0", muted && "opacity-50 grayscale", className)}
    >
      <defs>
        <linearGradient id={`bg-${uid}`} x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
        <linearGradient id={`shine-${uid}`} x1="24" y1="0" x2="24" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill={`url(#bg-${uid})`} />
      <rect width="48" height="48" rx="12" fill={`url(#shine-${uid})`} />
      {GLYPHS[id]}
    </svg>
  )
}

const GRADIENTS: Record<Product["id"], [string, string]> = {
  portal: ["#F97316", "#1F2A44"],
  ingestiq: ["#3B82F6", "#0D9488"],
  insightiq: ["#8B5CF6", "#DB2777"],
  settings: ["#64748B", "#1E293B"],
}

const GLYPHS: Record<Product["id"], React.ReactNode> = {
  // data flowing down into the medallion layers: gold on top, then silver, then bronze
  ingestiq: (
    <g strokeLinecap="round" strokeLinejoin="round">
      <path d="M24 8v9" stroke="#fff" strokeWidth="2.6" fill="none" />
      <path d="M19.5 13.5 24 18l4.5-4.5" stroke="#fff" strokeWidth="2.6" fill="none" />
      <path d="M24 36.5 11 31l13-5.5L37 31z" fill="#C98A5A" stroke="#fff" strokeWidth="1.6" />
      <path d="M24 32 11 26.5 24 21l13 5.5z" fill="#E2E8F0" stroke="#fff" strokeWidth="1.6" />
      <path d="M24 27.5 11 22l13-5.5L37 22z" fill="#FACC15" stroke="#fff" strokeWidth="1.6" />
    </g>
  ),
  // a rising bar chart with a trend line and a spark
  insightiq: (
    <g strokeLinecap="round" strokeLinejoin="round">
      <rect x="11" y="27" width="5.5" height="10" rx="1.6" fill="#fff" fillOpacity="0.55" />
      <rect x="19.5" y="22" width="5.5" height="15" rx="1.6" fill="#fff" fillOpacity="0.75" />
      <rect x="28" y="17" width="5.5" height="20" rx="1.6" fill="#fff" />
      <path d="M11 22.5 19 16l6 3.5 9-8" stroke="#fff" strokeWidth="2.4" fill="none" />
      <circle cx="34" cy="11.5" r="2.2" fill="#fff" />
      <path
        d="M38.5 21.5c.3 1.6 1 2.3 2.6 2.6-1.6.3-2.3 1-2.6 2.6-.3-1.6-1-2.3-2.6-2.6 1.6-.3 2.3-1 2.6-2.6z"
        fill="#FDE68A"
      />
    </g>
  ),
  // settings sliders and a person (server settings and users)
  settings: (
    <g strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 15h16M11 24h9M11 33h11" stroke="#fff" strokeOpacity="0.6" strokeWidth="2.4" fill="none" />
      <circle cx="21" cy="15" r="3.2" fill="#fff" />
      <circle cx="15" cy="24" r="3.2" fill="#fff" />
      <circle cx="31.5" cy="25.5" r="4.2" fill="#38BDF8" stroke="#fff" strokeWidth="1.6" />
      <path d="M25 37c.6-3.6 3.4-5.6 6.5-5.6s5.9 2 6.5 5.6" fill="#38BDF8" stroke="#fff" strokeWidth="1.6" />
    </g>
  ),
  // the portal: four tiles, one per product and more to come
  portal: (
    <g fill="#fff">
      <rect x="12" y="12" width="10.5" height="10.5" rx="3" />
      <rect x="25.5" y="12" width="10.5" height="10.5" rx="3" fillOpacity="0.7" />
      <rect x="12" y="25.5" width="10.5" height="10.5" rx="3" fillOpacity="0.7" />
      <rect x="25.5" y="25.5" width="10.5" height="10.5" rx="3" fillOpacity="0.45" />
    </g>
  ),
}
