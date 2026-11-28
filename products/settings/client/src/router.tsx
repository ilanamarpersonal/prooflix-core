import { createBrowserRouter } from "react-router"

import { ProductApp } from "@prooflix/ui/app/product-app"

import { useSettingsCommands } from "@/lib/commands"
import { AiAssistPage } from "@/pages/ai-assist-page"
import { SystemPage } from "@/pages/system-page"
import { UsersPage } from "@/pages/users-page"

// Each top-level area is a tab; see SCREENS in @prooflix/ui/app/screens. "/" goes to the first tab the user has.
export const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <ProductApp productId="settings" useCommands={useSettingsCommands} />,
      children: [
        { path: "system", element: <SystemPage /> },
        { path: "users", element: <UsersPage /> },
        { path: "ai-assist", element: <AiAssistPage /> },
      ],
    },
  ],
  // Settings & Management is served under /settings/ (the portal is at /)
  { basename: "/settings" },
)
