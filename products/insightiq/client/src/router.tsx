import { createBrowserRouter } from "react-router"

import { ProductApp } from "@prooflix/ui/app/product-app"
import { useInsightiqCommands } from "@/lib/commands"
import { AuditPage } from "@/pages/audit-page"
import { ObjectRoute, ObjectsPage } from "@/pages/objects-page"
import { OntologyPage } from "@/pages/ontology-page"
import { OntologyWizardPage } from "@/pages/ontology-wizard-page"
import { SetsPage } from "@/pages/sets-page"

export const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <ProductApp productId="insightiq" useCommands={useInsightiqCommands} />,
      children: [
        { path: "ontology", element: <OntologyPage /> },
        { path: "ontology/new", element: <OntologyWizardPage key="new" /> },
        { path: "ontology/audit", caseSensitive: true, element: <AuditPage /> }, // a type named Audit stays /ontology/Audit
        { path: "ontology/:name", element: <OntologyWizardPage /> },
        { path: "objects", element: <ObjectsPage /> },
        { path: "objects/sets", element: <SetsPage key="new" /> },
        { path: "objects/sets/:id", element: <SetsPage /> },
        { path: "objects/:type/:pk", element: <ObjectRoute /> },
      ],
    },
  ],
  // InsightIQ is served under /insightiq/ (the portal is at /)
  { basename: "/insightiq" },
)
