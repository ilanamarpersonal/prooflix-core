// The Settings & Management API's types (a mirror of the server's schemas)

/** A server setting, from a PROOFLIX_* environment variable (GET /api/system/parameters). */
export interface SystemParameter {
  name: string
  /** what the server uses now; null: not set */
  value: string | null
  /** what is used when the variable is not set */
  default: string
  /** where the value in use comes from */
  source: "saved" | "environment" | "default"
  description: string
  editable: boolean
  /** "folder": a path on the server, chosen with a folder browser; "date": a date picker */
  kind: "folder" | "date" | "text" | "secret"
  /** the value edited in the System tab, if any (used from the next start) */
  saved: string | null
  /** the saved value changed since the last (re)start */
  restart_needed: boolean
  /** applied by Restart server; false: only restarting the server process applies it */
  live: boolean
}

/** AI Assist: Claude in Prooflix. The settings as the browser sees them (never the key itself). */
export interface AiAssistSettings {
  enabled: boolean
  model: string
  effort: "low" | "medium" | "high"
  key_source: "saved" | "environment" | "none"
  /** the key's last four characters, "…abcd" */
  key_hint: string | null
  /** the key's kind, "sk-ant-api03" (not secret); null when unknown */
  key_prefix: string | null
  /** when the saved key was set (UTC, ISO 8601); null for the environment's key */
  key_saved_at: string | null
  ready: boolean
  /** prices in US dollars per million tokens */
  models: { id: string; label: string; input_price: number; output_price: number }[]
}

export interface AiAssistSettingsIn {
  enabled: boolean
  model: string
  effort: string
  api_key?: string | null
  remove_key?: boolean
}

// the signed-in user, shared by every product
export type { AuthStatus, AuthUser as AppUser } from "@prooflix/ui/auth/api"
