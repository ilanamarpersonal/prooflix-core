import { AlertCircle } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ApiError } from "@/lib/api"

export function ErrorAlert({ title = "Something went wrong", error }: { title?: string; error: unknown }) {
  const messages =
    error instanceof ApiError && error.errors.length
      ? error.errors
      : [error instanceof Error ? error.message : String(error)]
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {messages.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

export function ValidationErrors({ errors }: { errors: string[] }) {
  if (!errors.length) return null
  return <ErrorAlert title="Validation errors" error={new ApiError(422, errors[0], errors)} />
}
