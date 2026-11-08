import { useState } from "react"
import { NavLink, Outlet } from "react-router"
import { History, Moon, Sun, Workflow } from "lucide-react"

import prooflixMark from "@/assets/prooflix-mark.svg"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const NAV = [
  { to: "/pipelines", label: "Pipelines", icon: Workflow },
  { to: "/runs", label: "Runs", icon: History },
]

export function AppShell() {
  return (
    <div className="flex min-h-svh">
      <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border hidden w-56 shrink-0 flex-col border-r md:flex">
        <div className="flex h-14 items-center gap-2 px-4 font-semibold tracking-tight">
          <img src={prooflixMark} alt="" className="size-7" />
          Prooflix
        </div>
        <nav className="flex flex-col gap-1 px-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "hover:bg-sidebar-accent flex items-center gap-2 rounded-md px-3 py-2 text-sm",
                  isActive && "bg-sidebar-accent font-medium",
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto p-2">
          <ThemeToggle />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* compact top navigation on small screens */}
        <header className="flex h-12 items-center gap-1 border-b px-3 md:hidden">
          <span className="mr-2 flex items-center gap-1.5 font-semibold">
            <img src={prooflixMark} alt="" className="size-5" />
            Prooflix
          </span>
          {NAV.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn("rounded-md px-2 py-1 text-sm", isActive && "bg-accent font-medium")
              }
            >
              {label}
            </NavLink>
          ))}
          <div className="ml-auto">
            <ThemeToggle compact />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-8">
          <Outlet />
        </main>
      </div>
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
