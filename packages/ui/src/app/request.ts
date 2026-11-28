import { apiError } from "../lib/api-error"

const BASE = "/api"
/** fired when an API call answers 401, so the product sends the user to sign in */
export const UNAUTHORIZED_EVENT = "prooflix:unauthorized"

/** A JSON call to the Prooflix API (`path` after /api); throws ApiError with the server's messages. */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  })
  if (res.status === 204) return undefined as T
  // the session ended (expired, signed out elsewhere, password changed): sign in again
  if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  if (!res.ok) throw await apiError(res)
  return (await res.json().catch(() => null)) as T
}
