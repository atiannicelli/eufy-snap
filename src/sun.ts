import * as SunCalc from "suncalc";

export type SunEvent = "sunrise" | "sunset";
export const SUN_EVENTS: readonly SunEvent[] = ["sunrise", "sunset"];

export interface SunSchedule {
  event: SunEvent;
  /** Minutes relative to the event; negative = before. */
  offsetMin: number;
}

export interface SunPlan {
  /** Civil date in the configured timezone, YYYY-MM-DD. */
  date: string;
  event: SunEvent;
  /** When the sun event itself happens. */
  eventAt: Date;
  /** eventAt + offset — when the daily run should shoot. */
  fireAt: Date;
}

/** YYYY-MM-DD of `d` in `tz`. */
export function localDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** HH:MM (24 h) of `d` in `tz`. */
export function localTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

export function localDateTime(d: Date, tz: string): string {
  return `${localDate(d, tz)} ${localTime(d, tz)}`;
}

/** UTC offset of `tz` at instant `d`, in minutes (e.g. -240 for EDT). */
function tzOffsetMinutes(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(d);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /^GMT([+-])(\d{2}):?(\d{2})?$/.exec(name);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** The instant of local noon on `date` (YYYY-MM-DD) in `tz` — a safe anchor for a day's sun times. */
export function localNoon(date: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`bad date "${date}", want YYYY-MM-DD`);
  const guess = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  // Two passes so a DST transition on that very day still lands on the right offset.
  const first = new Date(guess.getTime() - tzOffsetMinutes(guess, tz) * 60_000);
  return new Date(guess.getTime() - tzOffsetMinutes(first, tz) * 60_000);
}

export function planFor(date: string, loc: { lat: number; lon: number; timezone: string }, schedule: SunSchedule): SunPlan {
  const noon = localNoon(date, loc.timezone);
  const times = SunCalc.getTimes(noon, loc.lat, loc.lon);
  const eventAt = times[schedule.event];
  if (!(eventAt instanceof Date) || Number.isNaN(eventAt.getTime())) {
    throw new Error(`no ${schedule.event} on ${date} at ${loc.lat},${loc.lon} (polar day/night?)`);
  }
  return { date, event: schedule.event, eventAt, fireAt: new Date(eventAt.getTime() + schedule.offsetMin * 60_000) };
}

/** Plan for today in the configured timezone. */
export function planToday(loc: { lat: number; lon: number; timezone: string }, schedule: SunSchedule, now = new Date()): SunPlan {
  return planFor(localDate(now, loc.timezone), loc, schedule);
}

/** "sunset −10 min" / "sunrise +5 min" — how the schedule reads in logs and headers. */
export function describeSchedule(s: SunSchedule): string {
  return `${s.event} ${s.offsetMin >= 0 ? "+" : "−"}${Math.abs(s.offsetMin)} min`;
}
