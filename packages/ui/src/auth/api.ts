import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { apiError } from "../lib/api-error"

/** The signed-in user, as /api/auth answers it. */
export interface AuthUser {
  username: string
  role: "admin" | "user"
  /** the tabs an admin gave a user (admins see every tab) */
  tabs: string[]
  /** the tabs this user sees: every tab plus "users" for an admin */
  visible_tabs: string[]
  /** the products this user can open (a product opens with any one of its tabs) */
  visible_products: string[]
  disabled: boolean
  created_at: string
  last_login: string | null
}

export interface AuthStatus {
  /** PROOFLIX_AUTH: false means no sign-in, every tab and every product */
  enabled: boolean
  /** no users yet: the sign-in page creates the first admin */
  setup_needed: boolean
  user: AuthUser | null
  /** every tab a user can be given */
  tabs: string[]
  /** the products the server serves */
  products: string[]
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/auth${path}`, {
    method: body === undefined && path === "/status" ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw await apiError(res)
  return (res.status === 204 ? undefined : await res.json()) as T
}

export const authApi = {
  status: () => call<AuthStatus>("/status"),
  login: (username: string, password: string) => call<AuthStatus>("/login", { username, password }),
  setupAdmin: (username: string, password: string) => call<AuthStatus>("/setup", { username, password }),
  logout: () => call<void>("/logout", {}),
  changePassword: (current: string, next: string) => call<AuthStatus>("/password", { current, new: next }),
}

/** Every product reads sign-in state under this one query key. */
export const AUTH_KEY = ["auth"]

export const useAuthStatus = () => useQuery({ queryKey: AUTH_KEY, queryFn: authApi.status, staleTime: 60_000 })

/** After signing in, out, or changing the password: new status, and every query fetched again. */
function useAuthChange<A>(fn: (a: A) => Promise<AuthStatus | void>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: AUTH_KEY })
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== AUTH_KEY[0] })
    },
  })
}

export const useLogin = () =>
  useAuthChange((c: { username: string; password: string }) => authApi.login(c.username, c.password))
export const useSetupAdmin = () =>
  useAuthChange((c: { username: string; password: string }) => authApi.setupAdmin(c.username, c.password))
export const useLogout = () => useAuthChange(() => authApi.logout())

export function useChangePassword() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ current, next }: { current: string; next: string }) => authApi.changePassword(current, next),
    onSuccess: (data) => qc.setQueryData(AUTH_KEY, data),
  })
}

/** Sends a signed-out user to the portal: they sign in there and land on its Home page. */
export function goToSignIn() {
  window.location.assign("/")
}
