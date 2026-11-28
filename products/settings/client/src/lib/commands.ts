import { useMemo } from "react"
import { useNavigate } from "react-router"
import { UserPlus } from "lucide-react"

import type { Command } from "@prooflix/ui/app/command-palette"
import type { UseCommands } from "@prooflix/ui/app/product-app"

/** Settings & Management's search commands: adding a user (admins). */
export const useSettingsCommands: UseCommands = (sections, user) => {
  const navigate = useNavigate()
  const commands = useMemo<Command[]>(
    () =>
      (!user || user.role === "admin") && sections.some((s) => s.id === "users")
        ? [{ id: "add-user", group: "Actions", label: "Add user", icon: UserPlus, run: () => navigate("/users") }]
        : [],
    [sections, user, navigate],
  )
  return { commands, groups: [], loading: false }
}
