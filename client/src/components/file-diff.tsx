/** One line of a diff: unchanged, removed or added. */
type DiffLine = { kind: " " | "-" | "+"; text: string }

const MAX_LINES = 3000 // beyond this, show the new content instead of comparing line by line
const CONTEXT = 3 // unchanged lines kept around each change

/** Line-by-line differences between two texts (longest common subsequence). */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n")
  const b = after.split("\n")
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: "-", text: a[i++] })
    else out.push({ kind: "+", text: b[j++] })
  }
  while (i < a.length) out.push({ kind: "-", text: a[i++] })
  while (j < b.length) out.push({ kind: "+", text: b[j++] })
  return out
}

/** A file's changes as a diff: removed lines red, added lines green, long unchanged stretches folded. */
export function FileDiff({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after)
  if (!lines)
    return (
      <pre className="bg-muted max-h-80 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre">{after}</pre>
    )
  const near = lines.map((_, k) => lines.slice(Math.max(0, k - CONTEXT), k + CONTEXT + 1).some((l) => l.kind !== " "))
  const rows: React.ReactNode[] = []
  let skipped = 0
  lines.forEach((line, k) => {
    if (!near[k]) {
      skipped++
      return
    }
    if (skipped) {
      rows.push(
        <div key={`skip-${k}`} className="text-muted-foreground px-2 py-0.5 italic">
          … {skipped} unchanged line{skipped === 1 ? "" : "s"}
        </div>,
      )
      skipped = 0
    }
    rows.push(
      <div
        key={k}
        className={
          line.kind === "-"
            ? "bg-red-500/10 text-red-700 dark:text-red-400"
            : line.kind === "+"
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : ""
        }
      >
        <span className="inline-block w-4 pl-1 select-none">{line.kind}</span>
        {line.text || " "}
      </div>,
    )
  })
  if (skipped)
    rows.push(
      <div key="skip-end" className="text-muted-foreground px-2 py-0.5 italic">
        … {skipped} unchanged line{skipped === 1 ? "" : "s"}
      </div>,
    )
  return (
    <div className="bg-muted/50 max-h-80 overflow-auto rounded-md border py-1 font-mono text-xs whitespace-pre">
      {rows}
    </div>
  )
}
