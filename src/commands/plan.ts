import { loadConfig } from "../app-config.ts";
import { describeSchedule, localDate, localNoon, localTime, planFor } from "../sun.ts";
import type { GlobalOpts } from "./app.ts";

interface PlanOpts extends GlobalOpts {
  days: string;
}

/** Show when the daily run would fire, and flag days the daemon's start time would be too late for. */
export function planCommand(date: string | undefined, opts: PlanOpts): void {
  const cfg = loadConfig(opts.config);
  const tz = cfg.location.timezone;
  const days = Math.max(1, Number(opts.days) || 1);
  const start = date ?? localDate(new Date(), tz);
  const { hour, minute } = cfg.schedule.daemonStart;
  const event = cfg.schedule.event;

  console.log(`${cfg.location.lat}, ${cfg.location.lon} (${tz}) — ${describeSchedule(cfg.schedule)}; daemon starts ${pad(hour)}:${pad(minute)}\n`);
  console.log(`date        ${event.padEnd(8)} shoot at`);
  let late = 0;
  for (let i = 0; i < days; i++) {
    const noon = localNoon(start, tz);
    const d = localDate(new Date(noon.getTime() + i * 86_400_000), tz);
    const p = planFor(d, cfg.location, cfg.schedule);
    const daemon = new Date(localNoon(d, tz).getTime() + ((hour - 12) * 60 + minute) * 60_000);
    const tooLate = p.fireAt < daemon;
    if (tooLate) late++;
    console.log(`${d}  ${localTime(p.eventAt, tz)}    ${localTime(p.fireAt, tz)}${tooLate ? "   ⚠ before daemon_start" : ""}`);
  }
  if (late) console.log(`\n⚠ ${late} day(s) fire before daemon_start ${pad(hour)}:${pad(minute)} — move schedule.daemon_start earlier.`);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
