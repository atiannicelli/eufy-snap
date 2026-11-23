import { loadConfig } from "../app-config.ts";
import { describeSchedule, localDate, localNoon, localTime, planFor } from "../sun.ts";
import type { GlobalOpts } from "./app.ts";

interface PlanOpts extends GlobalOpts {
  days: string;
}

/** Show when the day's shots would fire, and flag days the daemon's start time would be too late for. */
export function planCommand(date: string | undefined, opts: PlanOpts): void {
  const cfg = loadConfig(opts.config);
  const tz = cfg.location.timezone;
  const days = Math.max(1, Number(opts.days) || 1);
  const start = date ?? localDate(new Date(), tz);
  const { hour, minute } = cfg.schedule.daemonStart;
  const { shots } = cfg.schedule;
  const events = [...new Set(shots.map((s) => s.event))];
  const headers = shots.length === 1 ? ["shoot at"] : shots.map(describeSchedule);

  console.log(`${cfg.location.lat}, ${cfg.location.lon} (${tz}) — ${shots.map(describeSchedule).join(", ")}; daemon starts ${pad(hour)}:${pad(minute)}\n`);
  console.log(row("date", events, headers, headers));
  let late = 0;
  for (let i = 0; i < days; i++) {
    const noon = localNoon(start, tz);
    const d = localDate(new Date(noon.getTime() + i * 86_400_000), tz);
    const plans = shots.map((s) => planFor(d, cfg.location, s));
    const daemon = new Date(localNoon(d, tz).getTime() + ((hour - 12) * 60 + minute) * 60_000);
    const tooLate = plans.some((p) => p.fireAt < daemon);
    if (tooLate) late++;
    const eventTimes = events.map((e) => localTime(plans.find((p) => p.event === e)!.eventAt, tz));
    const fireTimes = plans.map((p) => localTime(p.fireAt, tz));
    console.log(`${row(d, eventTimes, fireTimes, headers)}${tooLate ? "   ⚠ before daemon_start" : ""}`);
  }
  if (late) console.log(`\n⚠ ${late} day(s) fire before daemon_start ${pad(hour)}:${pad(minute)} — move schedule.daemon_start earlier.`);
}

/** One table line: date, a column per sun event, a column per shot as wide as its header. */
function row(date: string, events: string[], fires: string[], headers: string[]): string {
  const cells = [date.padEnd(10), ...events.map((e) => e.padEnd(7)), ...fires.map((f, i) => f.padEnd(headers[i]!.length))];
  return cells.join("  ").trimEnd();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
