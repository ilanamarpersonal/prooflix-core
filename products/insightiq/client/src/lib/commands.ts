import { useMemo } from "react"
import { useNavigate } from "react-router"
import { useQuery } from "@tanstack/react-query"
import { Boxes, Network, Plus } from "lucide-react"

import type { Command } from "@prooflix/ui/app/command-palette"
import type { UseCommands } from "@prooflix/ui/app/product-app"
import { api } from "@/lib/api"

/** InsightIQ's search commands: a new object type, and every published type (in the Object Model or Objects tab). */
export const useInsightiqCommands: UseCommands = (sections) => {
  const navigate = useNavigate()
  const has = (id: string) => sections.some((s) => s.id === id)
  const types = useQuery({
    queryKey: ["ontology", "objects", "types"],
    queryFn: api.objectTypes,
    enabled: has("objects") || has("ontology"),
  })
  const commands = useMemo<Command[]>(() => {
    const out: Command[] = []
    if (has("ontology"))
      out.push({
        id: "new-type",
        group: "Actions",
        label: "New object type",
        icon: Plus,
        run: () => navigate("/ontology/new"),
      })
    for (const t of types.data ?? []) {
      if (has("objects"))
        out.push({
          id: `objects:${t.api_name}`,
          group: "Object types",
          label: t.plural || t.api_name,
          hint: "objects",
          icon: Boxes,
          keywords: `${t.api_name} ${t.source.table}`,
          run: () => navigate(`/objects?type=${t.api_name}`),
        })
      if (has("ontology"))
        out.push({
          id: `ontology:${t.api_name}`,
          group: "Object types",
          label: `Edit ${t.api_name}`,
          hint: t.source.layer ?? "",
          icon: Network,
          keywords: t.source.table,
          run: () => navigate(`/ontology/${t.api_name}`),
        })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.data, sections, navigate])
  return { commands, groups: ["Actions", "Object types"], loading: types.isLoading }
}
