import { NeedsHumanError, sleep } from "../client.ts";
import { CaptureError, runDaily, type DailyOptions } from "../daily.ts";
import { acquireLock, LockHeldError } from "../lock.ts";
import { error, errorMessage, info, warn } from "../log.ts";
import { todayHasPhoto } from "../store.ts";
import { localDateTime, localNoon, planToday, type SunPlan } from "../sun.ts";
import { alert, bootstrap, deliver, printOutcome, type App, type GlobalOpts } from "./app.ts";

/** Exit codes (DESIGN §8). 10 needs a human, 20 photo taken but off preset, 30 no photo, 40 photo saved but not delivered. */
export const EXIT = { ok: 0, needsHuman: 10, offPreset: 20, captureFailed: 30, deliveryFailed: 40 } as const;

interface SnapOpts extends GlobalOpts {
  telegram: boolean;
}

/** Shoot right now. */
export async function snapCommand(opts: SnapOpts): Promise<void> {
  const app = bootstrap(opts, "snap");
  const plan = planToday(app.cfg.location, app.cfg.schedule);
  process.exitCode = await shoot(app, { reason: "manual", date: plan.date, plan }, opts.telegram);
}

interface RunOpts extends GlobalOpts {
  at?: string;
  telegram: boolean;
}

/**
 * The daemon entry point: work out today's fire time, wait for it (wall clock, so a sleeping Mac
 * that wakes late still shoots inside the catch-up window), shoot, deliver.
 */
export async function runCommand(opts: RunOpts): Promise<void> {
  const app = bootstrap(opts, `run-${Date.now().toString(36)}`);
  const { cfg } = app;
  const tz = cfg.location.timezone;

  let release: () => void;
  try {
    release = acquireLock(cfg.paths.lock);
  } catch (e) {
    if (e instanceof LockHeldError) {
      warn(e.message);
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  try {
    const now = new Date();
    let plan = planToday(cfg.location, cfg.schedule, now);
    if (opts.at) plan = overrideFireAt(plan, opts.at, tz);

    if (todayHasPhoto(cfg.store.dir, now, tz)) {
      info(`already have a photo for ${plan.date} — nothing to do`);
      return;
    }
    info(`plan for ${plan.date}: ${plan.event} ${localDateTime(plan.eventAt, tz)}, shoot at ${localDateTime(plan.fireAt, tz)}`);

    const lateMs = now.getTime() - plan.fireAt.getTime();
    let reason: DailyOptions["reason"] = "scheduled";
    if (lateMs > cfg.schedule.catchUpMaxMin * 60_000) {
      const msg = `missed today's window by ${Math.round(lateMs / 60_000)} min (catch_up_max_min ${cfg.schedule.catchUpMaxMin}); skipping`;
      warn(msg);
      await alert(app, "skipped", new Error(msg));
      process.exitCode = 1;
      return;
    }
    if (lateMs > 0) {
      reason = "catch-up";
      info(`fire time passed ${Math.round(lateMs / 60_000)} min ago — catching up`);
    } else {
      await waitUntil(plan.fireAt);
      if (todayHasPhoto(cfg.store.dir, new Date(), tz)) {
        info("a photo appeared while waiting (manual snap?) — nothing to do");
        return;
      }
    }
    process.exitCode = await shoot(app, { reason, date: plan.date, plan }, opts.telegram);
  } finally {
    release();
  }
}

/** Sleep in short slices and re-read the clock, so a suspended process doesn't overshoot when it resumes. */
async function waitUntil(t: Date): Promise<void> {
  let announced = -1;
  for (;;) {
    const left = t.getTime() - Date.now();
    if (left <= 0) return;
    const leftMin = Math.ceil(left / 60_000);
    if (announced < 0 || leftMin <= 1 || announced - leftMin >= 30) {
      info(`waiting ${leftMin} min`);
      announced = leftMin;
    }
    await sleep(Math.min(left, 30_000));
  }
}

function overrideFireAt(plan: SunPlan, at: string, tz: string): SunPlan {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (!m) throw new Error(`--at wants HH:MM, got "${at}"`);
  const noon = localNoon(plan.date, tz);
  const fireAt = new Date(noon.getTime() + ((Number(m[1]) - 12) * 60 + Number(m[2])) * 60_000);
  warn(`fire time overridden to ${localDateTime(fireAt, tz)} (--at)`);
  return { ...plan, fireAt };
}

async function shoot(app: App, daily: DailyOptions, telegram: boolean): Promise<number> {
  const { cfg } = app;
  try {
    const outcome = await runDaily(cfg, daily);
    printOutcome(cfg, outcome);
    const delivered = telegram ? await deliver(app, outcome) : true;
    if (!delivered) return EXIT.deliveryFailed;
    return outcome.exitCode === 20 ? EXIT.offPreset : EXIT.ok;
  } catch (e) {
    if (e instanceof NeedsHumanError) {
      error(e.message);
      if (telegram) await alert(app, "needs a human (login)", e);
      return EXIT.needsHuman;
    }
    if (e instanceof CaptureError) {
      error(`capture failed: ${e.message}`);
      if (telegram) await alert(app, "capture failed", e);
      return EXIT.captureFailed;
    }
    error(`run failed: ${errorMessage(e)}`);
    if (telegram) await alert(app, "failed", e);
    return 1;
  }
}
