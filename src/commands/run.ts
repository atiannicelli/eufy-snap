import { NeedsHumanError, sleep } from "../client.ts";
import { CaptureError, isTransientError, runDaily, type DailyOptions } from "../daily.ts";
import { acquireLock, LockHeldError } from "../lock.ts";
import { error, errorMessage, info, warn } from "../log.ts";
import { hasScheduledPhoto } from "../store.ts";
import { describeSchedule, localDate, localDateTime, localNoon, localTime, planFor, planToday, type SunPlan } from "../sun.ts";
import { alert, bootstrap, deliver, printOutcome, type App, type GlobalOpts } from "./app.ts";

/** Exit codes (README "Exit codes"). 10 needs a human, 20 photo taken but off preset, 30 no photo, 40 photo saved but not delivered. */
export const EXIT = { ok: 0, needsHuman: 10, offPreset: 20, captureFailed: 30, deliveryFailed: 40 } as const;

interface SnapOpts extends GlobalOpts {
  telegram: boolean;
}

/** Shoot right now. */
export async function snapCommand(opts: SnapOpts): Promise<void> {
  const app = bootstrap(opts, "snap");
  const plan = planToday(app.cfg.location, app.cfg.schedule.shots[0]);
  process.exitCode = await shoot(app, { reason: "manual", date: plan.date, plan }, opts.telegram);
}

interface RunOpts extends GlobalOpts {
  at?: string;
  telegram: boolean;
}

interface PlannedShot {
  plan: SunPlan;
  fileSuffix: string | undefined;
  /** "sunset +10 min" — tells the day's shots apart in logs and alerts. */
  label: string;
}

/** Back-to-back P2P sessions are refused; leave the camera this long after one ends. */
const SESSION_GAP_MS = 30_000;

/**
 * The daemon entry point: work out today's fire times, then for each shot in turn wait for it (wall
 * clock, so a sleeping Mac that wakes late still shoots inside the catch-up window), shoot, deliver.
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
    const date = localDate(new Date(), tz);
    let shots: PlannedShot[] = cfg.schedule.shots
      .map((s) => ({ plan: planFor(date, cfg.location, s), fileSuffix: s.fileSuffix, label: describeSchedule(s) }))
      .sort((a, b) => a.plan.fireAt.getTime() - b.plan.fireAt.getTime());
    if (opts.at) shots = startAt(shots, opts.at, tz);

    let exit = 0;
    let cameraFreeAt = 0;
    for (const [i, shot] of shots.entries()) {
      const state = await awaitShot(app, shot);
      if (state === "done") continue;
      if (state === "missed") {
        exit = Math.max(exit, 1);
        continue;
      }
      const gap = cameraFreeAt - Date.now();
      if (gap > 0) {
        info(`waiting ${Math.ceil(gap / 1000)} s for the camera to release the previous session`);
        await sleep(gap);
      }
      const code = await shoot(app, { reason: state, date: shot.plan.date, plan: shot.plan, fileSuffix: shot.fileSuffix }, opts.telegram);
      cameraFreeAt = Date.now() + SESSION_GAP_MS;
      exit = Math.max(exit, code);
      if (code === EXIT.needsHuman) {
        if (i < shots.length - 1) warn("login needs a human — not attempting today's remaining shots");
        break;
      }
    }
    process.exitCode = exit;
  } finally {
    release();
  }
}

/** Decide what to do about one shot, sleeping until its fire time if that is still ahead. */
async function awaitShot(app: App, shot: PlannedShot): Promise<"done" | "missed" | "scheduled" | "catch-up"> {
  const { cfg } = app;
  const tz = cfg.location.timezone;
  const { plan, label } = shot;

  if (hasScheduledPhoto(cfg.store.dir, plan.date, shot.fileSuffix)) {
    info(`already have the ${label} photo for ${plan.date} — nothing to do`);
    return "done";
  }
  info(`plan for ${plan.date}: ${plan.event} ${localDateTime(plan.eventAt, tz)}, shoot at ${localDateTime(plan.fireAt, tz)}`);

  const lateMs = Date.now() - plan.fireAt.getTime();
  if (lateMs > cfg.schedule.catchUpMaxMin * 60_000) {
    const msg = `missed today's ${label} window by ${Math.round(lateMs / 60_000)} min (catch_up_max_min ${cfg.schedule.catchUpMaxMin}); skipping`;
    warn(msg);
    await alert(app, "skipped", new Error(msg));
    return "missed";
  }
  if (lateMs > 0) {
    info(`fire time passed ${Math.round(lateMs / 60_000)} min ago — catching up`);
    return "catch-up";
  }
  await waitUntil(plan.fireAt);
  if (hasScheduledPhoto(cfg.store.dir, plan.date, shot.fileSuffix)) {
    info("a scheduled photo appeared while waiting (another run?) — nothing to do");
    return "done";
  }
  return "scheduled";
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

/** `--at`: move the day's first shot to HH:MM and every later one by the same amount. */
function startAt(shots: PlannedShot[], at: string, tz: string): PlannedShot[] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (!m) throw new Error(`--at wants HH:MM, got "${at}"`);
  const first = shots[0];
  if (!first) return shots;
  const noon = localNoon(first.plan.date, tz);
  const fireAt = new Date(noon.getTime() + ((Number(m[1]) - 12) * 60 + Number(m[2])) * 60_000);
  const shiftMs = fireAt.getTime() - first.plan.fireAt.getTime();
  warn(`fire time overridden to ${localDateTime(fireAt, tz)} (--at)${shots.length > 1 ? "; later shots keep their spacing" : ""}`);
  return shots.map((s) => ({ ...s, plan: { ...s.plan, fireAt: new Date(s.plan.fireAt.getTime() + shiftMs) } }));
}

/** Pause between whole-session attempts when the camera could not be reached. */
const SESSION_RETRY_MS = 2 * 60_000;

async function shoot(app: App, daily: DailyOptions, telegram: boolean): Promise<number> {
  const { cfg } = app;
  const tz = cfg.location.timezone;
  // Scheduled runs keep trying until fireAt + retry_window_min: a late frame beats a missing day.
  // Manual `snap` fails fast — someone is watching.
  const deadline = daily.reason !== "manual" && daily.plan ? daily.plan.fireAt.getTime() + cfg.schedule.retryWindowMin * 60_000 : 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const outcome = await runDaily(cfg, { ...daily, priorFailures: attempt - 1 });
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
      const transient = e instanceof CaptureError || isTransientError(e);
      const next = Date.now() + SESSION_RETRY_MS;
      if (transient && next < deadline) {
        warn(`attempt ${attempt} failed: ${errorMessage(e)} — retrying at ${localTime(new Date(next), tz)} (until ${localTime(new Date(deadline), tz)})`);
        await sleep(SESSION_RETRY_MS);
        continue;
      }
      const after = attempt > 1 ? ` after ${attempt} attempts` : "";
      if (e instanceof CaptureError) {
        error(`capture failed${after}: ${e.message}`);
        if (telegram) await alert(app, `capture failed${after}`, e);
        return EXIT.captureFailed;
      }
      error(`run failed${after}: ${errorMessage(e)}`);
      if (telegram) await alert(app, `failed${after}`, e);
      return 1;
    }
  }
}
