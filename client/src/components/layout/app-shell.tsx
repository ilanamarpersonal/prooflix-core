import { useEffect, useState } from "react"
import { Navigate, Outlet } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { Loader2, Moon, Sun } from "lucide-react"

import prooflixLogo from "@/assets/prooflix-logo.svg"
import prooflixLogoDark from "@/assets/prooflix-logo-dark.svg"
import { LoginPage } from "@/components/auth/login-page"
import { UserMenu } from "@/components/auth/user-menu"
import { ErrorAlert } from "@/components/error-alert"
import { Button } from "@/components/ui/button"
import { UNAUTHORIZED_EVENT, useAuthStatus } from "@/lib/api"
import { visibleSections, useTabs, type Section, type Tabs } from "@/lib/tabs"
import type { AppUser } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Signs the user in first when sign-in is on, then shows the app with their tabs. */
export function AppShell() {
  const qc = useQueryClient()
  const auth = useAuthStatus()

  // any API call answering 401: the session ended, so check again (shows the login page)
  useEffect(() => {
    const onUnauthorized = () => void qc.invalidateQueries({ queryKey: ["auth"] })
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [qc])

  if (auth.isLoading)
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </div>
    )
  if (auth.error || !auth.data)
    return (
      <div className="mx-auto max-w-lg p-6">
        <ErrorAlert title="Prooflix server is not reachable" error={auth.error ?? new Error("no answer")} />
      </div>
    )
  const { enabled, setup_needed, user } = auth.data
  if (enabled && !user) return <LoginPage setup={setup_needed} />
  return <Shell sections={visibleSections(enabled && user ? user.visible_tabs : null)} user={enabled ? user : null} />
}

function Shell({ sections, user }: { sections: Section[]; user: AppUser | null }) {
  const tabs = useTabs()

  return (
    <div className="flex min-h-svh flex-col">
      {/* full-width top bar with the logo */}
      <header className="bg-background sticky top-0 z-20 flex h-14 shrink-0 items-center gap-1 border-b px-4">
        <div className="mr-3 flex shrink-0 items-center">
          {/* the wordmark's navy letters, swapped for light ones in dark mode */}
          <img src={prooflixLogo} alt="Prooflix" width={105} height={24} className="h-6 w-auto dark:hidden" />
          <img src={prooflixLogoDark} alt="Prooflix" width={105} height={24} className="hidden h-6 w-auto dark:block" />
        </div>
        {/* on small screens the menu sits in the top bar */}
        <nav className="flex items-center gap-1 md:hidden">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => tabs.select(id)}
              aria-label={label}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-sm",
                tabs.active === id && "bg-accent font-medium",
              )}
            >
              <Icon className="size-4" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          {user && <UserMenu user={user} />}
          <div className="md:hidden">
            <ThemeToggle compact />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border sticky top-14 hidden h-[calc(100svh-3.5rem)] w-56 shrink-0 flex-col border-r pt-3 md:flex">
          <nav className="flex min-h-0 flex-col gap-1 overflow-y-auto px-2">
            {/* one plain item per section; the pipelines are listed in the Pipelines tab */}
            {sections.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => tabs.select(id)}
                className={cn(
                  "hover:bg-sidebar-accent flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm",
                  tabs.active === id && "bg-sidebar-accent font-medium",
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </nav>
          <div className="mt-auto p-2">
            <ThemeToggle />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <TabBar tabs={tabs} sections={sections} />
          <main className="w-full min-w-0 flex-1 p-4 md:p-6">
            {sections.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No tabs have been given to your account yet. Ask an admin to choose the tabs you can see.
              </p>
            ) : tabs.active && sections.some((s) => s.id === tabs.active) ? (
              <Outlet />
            ) : (
              // the start page is the first tab the user has (Pipelines when they have it)
              <Navigate to={sections[0].home} replace />
            )}
          </main>
        </div>
      </div>
    </div>
  )
}

/** All tabs, always shown above the content; the selected one is highlighted. */
function TabBar({ tabs, sections }: { tabs: Tabs; sections: Section[] }) {
  return (
    <div
      role="tablist"
      aria-label="Sections"
      className="bg-muted/40 sticky top-14 z-10 flex h-10 shrink-0 items-end gap-px overflow-x-auto border-b px-2"
    >
      {sections.map(({ id, label, icon: Icon }) => {
        const active = tabs.active === id
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => tabs.select(id)}
            className={cn(
              "-mb-px flex h-9 shrink-0 items-center gap-2 rounded-t-md border border-b-0 px-4 text-sm",
              active
                ? "bg-background border-border text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-background/60 border-transparent",
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        )
      })}
    </div>
  )
}

function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  const toggle = () => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle("dark", next)
    try {
      localStorage.setItem("prooflix-theme", next ? "dark" : "light")
    } catch {
      /* storage unavailable */
    }
  }
  const Icon = dark ? Sun : Moon
  return (
    <Button
      variant="ghost"
      size={compact ? "icon" : "sm"}
      onClick={toggle}
      className={compact ? "" : "w-full justify-start"}
      aria-label="Toggle theme"
    >
      <Icon />
      {!compact && (dark ? "Light mode" : "Dark mode")}
    </Button>
  )
}
