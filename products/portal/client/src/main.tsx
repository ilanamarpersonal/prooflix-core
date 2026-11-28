import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { installDomGuard } from "@prooflix/ui/lib/dom-guard"
import { Portal } from "./portal"
import "./index.css"

// before React renders anything: survive page translation and extensions rewriting text
installDomGuard()

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Portal />
    </QueryClientProvider>
  </StrictMode>,
)
