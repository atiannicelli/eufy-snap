#!/usr/bin/env node
import { Command } from "commander";
import { NeedsHumanError } from "./client.ts";
import { loadDotEnv } from "./config.ts";
import { devicesCommand } from "./commands/devices.ts";
import { installCommand } from "./commands/install.ts";
import { loginCommand } from "./commands/login.ts";
import { planCommand } from "./commands/plan.ts";
import { presetsCommand } from "./commands/presets.ts";
import { referenceCommand } from "./commands/reference.ts";
import { rotateCommand } from "./commands/rotate.ts";
import { EXIT, runCommand, snapCommand } from "./commands/run.ts";
import { sequenceCommand } from "./commands/sequence.ts";
import { snapshotCommand } from "./commands/snapshot.ts";
import { sweepCommand } from "./commands/sweep.ts";
import { watchCommand } from "./commands/watch.ts";

loadDotEnv();

const program = new Command()
  .name("eufy-snap")
  .description("Daily sunrise snapshot from a fixed preset on a Eufy PTZ camera")
  .version("0.0.1")
  .option("-c, --config <file>", "config file (default $EUFY_SNAP_CONFIG or ~/.eufy-snap/config.yaml)");

/** Merge the global `--config` into a subcommand's options. */
const withGlobals = <T extends object>(opts: T): T & { config?: string } => {
  const config = program.opts<{ config?: string }>().config;
  return config ? { ...opts, config } : opts;
};

// ---- setup ------------------------------------------------------------------------------------

program
  .command("login")
  .description("interactive first-time login (2FA / captcha); persists the session for unattended runs")
  .action(loginCommand);

program
  .command("devices")
  .description("list devices and the capabilities this tool relies on")
  .option("--json", "dump full device manifests as JSON")
  .action(devicesCommand);

program
  .command("presets <sn>")
  .description("list stored PTZ presets; optionally goto / save / setDefault / fetch thumbnail")
  .option("--goto <id>", "move to preset id")
  .option("--save <id>", "save the camera's CURRENT position into preset id")
  .option("--set-default <id>", "make preset id the home position (previews it first)")
  .option("--image <id>", "download preset id's thumbnail to out/")
  .option("--settle <ms>", "wait after a move", "6000")
  .action(presetsCommand);

program
  .command("reference")
  .description("shoot from the shoot preset and save reference.jpg — daily runs verify their aim against it")
  .action(() => referenceCommand(withGlobals({})));

program
  .command("install")
  .description("render the LaunchDaemon plist into EUFY_SNAP_HOME and print the sudo steps to activate it")
  .option("--node <path>", "node binary the daemon should use (default: this one)")
  .option("--print", "print the plist to stdout instead of writing it", false)
  .action((opts) => installCommand(withGlobals(opts)));

// ---- daily ------------------------------------------------------------------------------------

program
  .command("plan [date]")
  .description("show sunrise and shoot time for a date (default today)")
  .option("--days <n>", "how many consecutive days to list", "1")
  .action((date: string | undefined, opts) => planCommand(date, withGlobals(opts)));

program
  .command("snap")
  .description("shoot now: goto shoot preset → capture → verify → save → return home → Telegram")
  .option("--no-telegram", "don't send to Telegram even if configured")
  .action((opts) => snapCommand(withGlobals(opts)));

program
  .command("run")
  .description("daemon entry: wait for today's shoot time (or catch up if late), then snap")
  .option("--at <HH:MM>", "override today's shoot time (testing)")
  .option("--no-telegram", "don't send to Telegram even if configured")
  .action((opts) => runCommand(withGlobals(opts)));

// ---- spike / diagnostics ----------------------------------------------------------------------

const dev = program.command("dev").description("low-level camera experiments from the Phase 0 spike");

dev
  .command("rotate <sn> <dir> [n]")
  .description("step the camera n times (left|right|up|down), logging PTZ status frames")
  .option("--delay <ms>", "pause between steps", "800")
  .option("--speed <1|3|5>", "set rotation speed first")
  .action((sn: string, dir: string, n: string | undefined, opts) => rotateCommand(sn, dir, n ?? "1", opts));

dev
  .command("snapshot <sn>")
  .description("take a fresh JPEG from the live stream (wakes a battery camera)")
  .option("--retries <n>", "attempts before giving up", "3")
  .option("--out <file>", "output path (default out/<sn>-<timestamp>.jpg)")
  .action(snapshotCommand);

dev
  .command("watch <sn>")
  .description("hold P2P open and dump PTZ status frames while you move the camera from the app")
  .option("--seconds <n>", "how long to listen", "60")
  .option("--nudge", "also step left then right so status frames are provoked")
  .action(watchCommand);

dev
  .command("sequence <sn>")
  .description("rehearse: home → steps → settle → snapshot → home")
  .requiredOption("--home <id>", "home preset id")
  .option("--dir <dir>", "step direction", "right")
  .option("--steps <n>", "number of steps from home", "2")
  .option("--step-delay <ms>", "pause between steps", "800")
  .option("--settle <ms>", "wait after moves before shooting", "6000")
  .option("--no-return", "leave the camera at the target instead of returning home")
  .action(sequenceCommand);

dev
  .command("sweep <sn>")
  .description("step in one direction in batches, snapshotting, until the pan end-stop; reports steps and °/step")
  .option("--from <id>", "goto this preset first (use one that sits at the opposite end-stop)")
  .option("--dir <dir>", "step direction", "right")
  .option("--batch <n>", "steps per batch (keep the per-batch view shift under ~40% of width)", "6")
  .option("--step-delay <ms>", "pause between steps", "600")
  .option("--settle <ms>", "wait after each batch before shooting", "3000")
  .option("--max <n>", "give up after this many steps", "150")
  .option("--speed <1|3|5>", "set rotation speed first")
  .option("--range <deg>", "model's pan range, for °/step", "355")
  .option("--zoom <n>", "rotate() zoom argument — reportedly scales step size", "1")
  .action(sweepCommand);

program.parseAsync().catch((e: unknown) => {
  if (e instanceof NeedsHumanError) {
    console.error(e.message);
    process.exit(EXIT.needsHuman);
  }
  console.error("FATAL", e instanceof Error ? (process.env.EUFY_LOG_LEVEL === "debug" ? e.stack : e.message) : String(e));
  process.exit(1);
});
