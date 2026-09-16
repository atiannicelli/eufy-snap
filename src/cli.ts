#!/usr/bin/env node
import { Command } from "commander";
import { NeedsHumanError } from "./client.ts";
import { loadDotEnv } from "./config.ts";
import { devicesCommand } from "./commands/devices.ts";
import { loginCommand } from "./commands/login.ts";
import { presetsCommand } from "./commands/presets.ts";
import { rotateCommand } from "./commands/rotate.ts";
import { sequenceCommand } from "./commands/sequence.ts";
import { snapshotCommand } from "./commands/snapshot.ts";
import { watchCommand } from "./commands/watch.ts";

loadDotEnv();

const program = new Command()
  .name("eufy-snap")
  .description("Daily sunrise-tracking snapshots from a Eufy PTZ camera")
  .version("0.0.1");

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
  .command("rotate <sn> <dir> [n]")
  .description("step the camera n times (left|right|up|down), logging PTZ status frames")
  .option("--delay <ms>", "pause between steps", "800")
  .option("--speed <1|3|5>", "set rotation speed first")
  .action((sn: string, dir: string, n: string | undefined, opts) => rotateCommand(sn, dir, n ?? "1", opts));

program
  .command("snapshot <sn>")
  .description("take a fresh JPEG from the live stream (wakes a battery camera)")
  .option("--retries <n>", "attempts before giving up", "3")
  .option("--out <file>", "output path (default out/<sn>-<timestamp>.jpg)")
  .action(snapshotCommand);

program
  .command("watch <sn>")
  .description("hold P2P open and dump PTZ status frames while you move the camera from the app")
  .option("--seconds <n>", "how long to listen", "60")
  .option("--nudge", "also step left then right so status frames are provoked")
  .action(watchCommand);

program
  .command("sequence <sn>")
  .description("rehearse the daily run: home → steps → settle → snapshot → home")
  .requiredOption("--home <id>", "home preset id")
  .option("--dir <dir>", "step direction", "right")
  .option("--steps <n>", "number of steps from home", "2")
  .option("--step-delay <ms>", "pause between steps", "800")
  .option("--settle <ms>", "wait after moves before shooting", "6000")
  .option("--no-return", "leave the camera at the target instead of returning home")
  .action(sequenceCommand);

program.parseAsync().catch((e: unknown) => {
  if (e instanceof NeedsHumanError) {
    console.error(e.message);
    process.exit(10);
  }
  console.error("FATAL", e instanceof Error ? (process.env.EUFY_LOG_LEVEL === "debug" ? e.stack : e.message) : String(e));
  process.exit(1);
});
