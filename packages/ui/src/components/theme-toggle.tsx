import { useState } from "react"
import { Moon, Sun } from "lucide-react"

import { Button } from "./ui/button"

/** The browser key every product keeps the theme under, so all of them switch together. */
export const THEME_KEY = "prooflix-theme"

/** Switches light and dark mode and remembers the choice in the browser. */
export function setTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark)
  try {
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light")
  } catch {
    /* storage unavailable */
  }
}

/** The light/dark button at the bottom of the menu (an icon only when compact). */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  const toggle = () => {
    setDark(!dark)
    setTheme(!dark)
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
