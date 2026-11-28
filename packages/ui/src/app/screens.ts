import {
  ArrowDownToLine,
  BellRing,
  Boxes,
  Database,
  DatabaseZap,
  FolderTree,
  Library,
  Network,
  Shapes,
  SlidersHorizontal,
  UsersRound,
  Workflow,
} from "lucide-react"

import { AiAssistIcon } from "../ai-assist/icon"
import type { Product } from "../lib/products"
import type { Section } from "./sections"

/** A tab of one of the products. The server gives access per tab (TAB_PATHS, PRODUCT_TABS in auth.py). */
export interface Screen extends Section {
  product: Product["id"]
}

/** Each product's menu groups, in order. */
export const GROUPS: Record<"ingestiq" | "insightiq" | "settings", { id: string; label: string }[]> = {
  ingestiq: [
    { id: "build", label: "Build" },
    { id: "data", label: "Data" },
    { id: "monitor", label: "Monitor" },
  ],
  insightiq: [
    { id: "model", label: "Model" },
    { id: "explore", label: "Explore" },
  ],
  settings: [
    { id: "platform", label: "Platform" },
    { id: "access", label: "Access" },
  ],
}

/**
 * Every tab of every product, in menu order: one list, so each product's menu, the Users tab's tab
 * picker and links between products (AI Assist's "Open …" button) agree.
 */
export const SCREENS: Screen[] = [
  {
    id: "pipelines",
    product: "ingestiq",
    group: "build",
    label: "Pipelines",
    icon: Workflow,
    color: "#378ADD",
    home: "/pipelines",
    prefixes: ["/pipelines", "/runs"],
  },
  {
    id: "ingestion",
    product: "ingestiq",
    group: "build",
    label: "Ingestion",
    icon: ArrowDownToLine,
    color: "#1D9E75",
    home: "/ingestion",
    prefixes: ["/ingestion"],
  },
  {
    id: "workspace",
    product: "ingestiq",
    group: "build",
    label: "Workspace",
    icon: FolderTree,
    color: "#BA7517",
    home: "/workspace",
    prefixes: ["/workspace"],
  },
  {
    id: "sql",
    product: "ingestiq",
    group: "data",
    label: "SQL Editor",
    icon: Database,
    color: "#7F77DD",
    home: "/sql",
    prefixes: ["/sql"],
  },
  {
    id: "catalog",
    product: "ingestiq",
    group: "data",
    label: "Catalog",
    icon: Library,
    color: "#D85A30",
    home: "/catalog",
    prefixes: ["/catalog"],
  },
  {
    id: "semantic",
    product: "ingestiq",
    group: "data",
    label: "Semantic model",
    icon: Shapes,
    color: "#D4537E",
    home: "/semantic",
    prefixes: ["/semantic"],
  },
  {
    id: "clickhouse",
    product: "ingestiq",
    group: "data",
    label: "ClickHouse",
    icon: DatabaseZap,
    color: "#D9A21B",
    home: "/clickhouse",
    prefixes: ["/clickhouse"],
  },
  {
    id: "alerts",
    product: "ingestiq",
    group: "monitor",
    label: "Alerts",
    icon: BellRing,
    color: "#E24B4A",
    home: "/alerts",
    prefixes: ["/alerts"],
  },
  {
    id: "ontology",
    product: "insightiq",
    group: "model",
    label: "Object Model",
    icon: Network,
    color: "#8B5CF6",
    home: "/ontology",
    prefixes: ["/ontology"],
  },
  {
    id: "objects",
    product: "insightiq",
    group: "explore",
    label: "Objects",
    icon: Boxes,
    color: "#DB2777",
    home: "/objects",
    prefixes: ["/objects"],
  },
  {
    id: "system",
    product: "settings",
    group: "platform",
    label: "System",
    icon: SlidersHorizontal,
    color: "#888780",
    home: "/system",
    prefixes: ["/system"],
  },
  {
    id: "users",
    product: "settings",
    group: "access",
    label: "Users",
    icon: UsersRound,
    color: "#639922",
    home: "/users",
    prefixes: ["/users"],
  },
  {
    id: "ai-assist",
    product: "settings",
    group: "platform",
    label: "AI Assist",
    icon: AiAssistIcon,
    home: "/ai-assist",
    prefixes: ["/ai-assist"],
  },
]

export const productScreens = (id: Product["id"]) => SCREENS.filter((s) => s.product === id)
