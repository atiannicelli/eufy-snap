import fs from "node:fs";
import os from "node:os";
import { sendMessage, sendPhoto } from "../telegram.ts";
import { bootstrap, type GlobalOpts } from "./app.ts";

/**
 * Prove Telegram delivery without touching the camera: a text message, or `--photo` to send
 * `reference.jpg` through the same `sendPhoto` path the daily run uses.
 */
export async function telegramTestCommand(opts: GlobalOpts & { photo?: boolean }): Promise<void> {
  const { cfg, tg } = bootstrap(opts, "telegram-test");
  if (!tg) {
    throw new Error(
      `Telegram is not configured: set ${cfg.telegram.botTokenEnv} and ${cfg.telegram.chatIdEnv} in .env or ${process.env.EUFY_SNAP_HOME ?? "~/.eufy-snap"}/env`,
    );
  }
  const stamp = new Date().toLocaleString("en-US", { timeZone: cfg.location.timezone });
  const text = `eufy-snap test from ${os.hostname()} · ${stamp}`;
  if (opts.photo) {
    if (!fs.existsSync(cfg.paths.reference)) throw new Error(`no ${cfg.paths.reference} — run \`eufy-snap reference\` first, or omit --photo`);
    await sendPhoto(tg, fs.readFileSync(cfg.paths.reference), `${text} (reference.jpg)`, "reference.jpg");
    console.log(`sent reference.jpg to chat ${tg.chatId}`);
  } else {
    await sendMessage(tg, text);
    console.log(`sent "${text}" to chat ${tg.chatId}`);
  }
}
