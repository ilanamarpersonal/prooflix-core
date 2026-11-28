/** An error answer from a Prooflix API: the status and the server's messages (``detail``). */
export class ApiError extends Error {
  status: number
  errors: string[]
  /** the server's raw error detail, for responses that carry more than messages */
  detail: unknown

  constructor(status: number, message: string, errors: string[] = [], detail?: unknown) {
    super(message)
    this.status = status
    this.errors = errors
    this.detail = detail
  }
}

/** The messages to show for an error: the server's list, or the error's own message. */
export function errorMessages(error: unknown): string[] {
  if (error instanceof ApiError && error.errors.length) return error.errors
  return [error instanceof Error ? error.message : String(error)]
}

/** Turns a failed response into an ApiError with the server's messages. */
export async function apiError(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => null)
  const detail = body?.detail
  const errors: string[] = Array.isArray(detail?.errors)
    ? detail.errors
    : typeof detail === "string"
      ? [detail]
      : Array.isArray(detail)
        ? detail.map((d: { msg?: string }) => d.msg ?? JSON.stringify(d))
        : []
  return new ApiError(res.status, errors[0] ?? res.statusText, errors, detail)
}
