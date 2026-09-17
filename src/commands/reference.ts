import fs from "node:fs";
import { runDaily } from "../daily.ts";
import { describeShift, frameShift } from "../frame-shift.ts";
import { localDate } from "../sun.ts";
import { bootstrap, printOutcome, type GlobalOpts } from "./app.ts";

/**
 * Capture the reference frame every daily run is verified against. Run it once after saving the
 * shoot preset in the Eufy app, and again whenever you deliberately re-aim that preset.
 */
export async function referenceCommand(opts: GlobalOpts): Promise<void> {
  const app = bootstrap(opts, "reference");
  const { cfg } = app;
  const previous = fs.existsSync(cfg.paths.reference) ? fs.readFileSync(cfg.paths.reference) : undefined;
  if (previous) {
    fs.copyFileSync(cfg.paths.reference, cfg.paths.reference.replace(/\.jpg$/, ".prev.jpg"));
  }

  const outcome = await runDaily(cfg, { reason: "reference", date: localDate(new Date(), cfg.location.timezone), asReference: true });
  printOutcome(cfg, outcome);
  if (previous) {
    console.log(`  vs previous reference: ${describeShift(frameShift(previous, outcome.jpeg))} (previous kept as reference.prev.jpg)`);
  }
  console.log(`\nLook at ${outcome.file} — if it is not the view you want, re-save the preset in the Eufy app (camera slot ${cfg.camera.shootPreset} = app preset ${cfg.camera.shootPreset + 1}) and run this again.`);
}
