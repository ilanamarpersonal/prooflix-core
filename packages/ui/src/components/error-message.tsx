import { AlertCircle } from "lucide-react"

import { errorMessages } from "../lib/api-error"
import { Alert, AlertDescription, AlertTitle } from "./ui/alert"

/** A failed request on a shared screen (sign-in, password): the title and the server's messages. */
export function ErrorMessage({ title, error }: { title: string; error: unknown }) {
  const messages = errorMessages(error)
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
