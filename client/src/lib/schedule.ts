/**
 * Trigger options for a pipeline, and how they map to the cron expression stored
 * in the pipeline's YAML (`schedule.cron`). A cron that matches one of the options
 * opens in that option; any other cron opens as "Custom".
 *
 * Crons have five fields (minute hour day-of-month month day-of-week), or six with
 * a leading seconds field for schedules finer than a minute ("*\/15 * * * * *").
 */

export type TriggerKind = "manual" | "seconds" | "minutes" | "hourly" | "daily" | "weekly" | "monthly" | "cron"

export interface TriggerForm {
  kind: TriggerKind
  everySeconds: number // seconds, for "seconds"
  every: number // minutes, for "minutes"
  minute: number // minute past the hour, for "hourly"
  time: string // "HH:MM", for daily / weekly / monthly
  days: number[] // weekdays, 0 = Sunday, for "weekly"
  day: number // day of the month, for "monthly"
  cron: string // for "cron"
}

export const TRIGGER_KINDS: { kind: TriggerKind; label: string }[] = [
  { kind: "manual", label: "Manual only" },
  { kind: "seconds", label: "Every few seconds" },
  { kind: "minutes", label: "Every few minutes" },
  { kind: "hourly", label: "Every hour" },
  { kind: "daily", label: "Every day" },
  { kind: "weekly", label: "Every week" },
  { kind: "monthly", label: "Every month" },
  { kind: "cron", label: "Custom (cron)" },
]

export const SECOND_STEPS = [1, 2, 5, 10, 15, 20, 30]
export const MINUTE_STEPS = [1, 2, 5, 10, 15, 20, 30]
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export const DEFAULT_FORM: TriggerForm = {
  kind: "manual",
  everySeconds: 15,
  every: 15,
  minute: 0,
  time: "02:00",
  days: [1, 2, 3, 4, 5],
  day: 1,
  cron: "0 * * * *",
}

const pad = (n: number) => String(n).padStart(2, "0")
const hm = (time: string) => {
  const [h, m] = time.split(":").map((x) => Number(x))
  return { h: Number.isFinite(h) ? h : 0, m: Number.isFinite(m) ? m : 0 }
}

/** The cron expression for a form, or null for "Manual only". */
export function toCron(f: TriggerForm): string | null {
  const { h, m } = hm(f.time)
  switch (f.kind) {
    case "manual":
      return null
    case "seconds":
      return f.everySeconds === 1 ? "* * * * * *" : `*/${f.everySeconds} * * * * *`
    case "minutes":
      return f.every === 1 ? "* * * * *" : `*/${f.every} * * * *`
    case "hourly":
      return `${f.minute} * * * *`
    case "daily":
      return `${m} ${h} * * *`
    case "weekly":
      return `${m} ${h} * * ${[...f.days].sort((a, b) => a - b).join(",") || "1"}`
    case "monthly":
      return `${m} ${h} ${f.day} * *`
    case "cron":
      return f.cron.trim().replace(/\s+/g, " ")
  }
}

const int = (s: string, lo: number, hi: number) => (/^\d+$/.test(s) && +s >= lo && +s <= hi ? +s : null)

/** The form that shows a stored cron expression (null cron: "Manual only"). */
export function fromCron(cron: string | null | undefined): TriggerForm {
  if (!cron) return { ...DEFAULT_FORM }
  const base = { ...DEFAULT_FORM, cron }
  const f = cron.trim().split(/\s+/)
  if (f.length === 6) {
    // seconds first: "every n seconds" when the other fields are all "*"
    const [se, ...rest] = f
    if (rest.every((x) => x === "*")) {
      if (se === "*") return { ...base, kind: "seconds", everySeconds: 1 }
      const step = /^\*\/(\d+)$/.exec(se)
      if (step && SECOND_STEPS.includes(+step[1])) return { ...base, kind: "seconds", everySeconds: +step[1] }
    }
    return { ...base, kind: "cron" }
  }
  if (f.length !== 5) return { ...base, kind: "cron" }
  const [mi, ho, dom, mon, dow] = f
  if (mon !== "*") return { ...base, kind: "cron" }
  const minute = int(mi, 0, 59)
  const hour = int(ho, 0, 23)
  const time = minute !== null && hour !== null ? `${pad(hour)}:${pad(minute)}` : base.time
  if (ho === "*" && dom === "*" && dow === "*") {
    if (mi === "*") return { ...base, kind: "minutes", every: 1 }
    const step = /^\*\/(\d+)$/.exec(mi)
    if (step && MINUTE_STEPS.includes(+step[1])) return { ...base, kind: "minutes", every: +step[1] }
    if (minute !== null) return { ...base, kind: "hourly", minute }
  }
  if (minute !== null && hour !== null) {
    if (dom === "*" && dow === "*") return { ...base, kind: "daily", time }
    if (dom === "*" && /^[0-7](,[0-7])*$/.test(dow)) {
      const days = [...new Set(dow.split(",").map((d) => +d % 7))].sort((a, b) => a - b)
      return { ...base, kind: "weekly", time, days }
    }
    const day = int(dom, 1, 31)
    if (day !== null && dow === "*") return { ...base, kind: "monthly", time, day }
  }
  return { ...base, kind: "cron" }
}

const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`

/** "Every 15 seconds", "Every 15 minutes", "Daily at 02:00", "Weekdays at 09:00", "Cron 0 9 1-7 * 1"… */
export function describeCron(cron: string): string {
  const f = fromCron(cron)
  switch (f.kind) {
    case "seconds":
      return f.everySeconds === 1 ? "Every second" : `Every ${f.everySeconds} seconds`
    case "minutes":
      return f.every === 1 ? "Every minute" : `Every ${f.every} minutes`
    case "hourly":
      return f.minute === 0 ? "Every hour" : `Every hour at :${pad(f.minute)}`
    case "daily":
      return `Daily at ${f.time}`
    case "weekly": {
      const d = f.days.join(",")
      const which =
        d === "1,2,3,4,5" ? "Weekdays" : d === "0,6" ? "Weekends" : f.days.map((x) => WEEKDAYS[x]).join(", ")
      return `${which} at ${f.time}`
    }
    case "monthly":
      return `Monthly on the ${ordinal(f.day)} at ${f.time}`
    default:
      return `Cron ${cron}`
  }
}

/** Time zones the browser knows, with UTC and the browser's own zone first. */
export function timeZones(): string[] {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone
  let all: string[] = []
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []
  } catch {
    all = []
  }
  return [...new Set(["UTC", local, ...all].filter(Boolean))]
}
