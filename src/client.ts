import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import {
  ConsoleLogger,
  EufyMega,
  FileSessionStore,
  LoginStatus,
  type EufyMegaOptions,
} from "@mega-yfue/eufy-sdk";
import { logLevel, requireEnv, sessionFile, stateDir } from "./config.ts";

/** Raised when login needs a captcha or 2FA code and we are running unattended. */
export class NeedsHumanError extends Error {
  readonly status: string;
  constructor(status: string) {
    super(`login needs a human (${status}) — run \`eufy-snap login\` interactively`);
    this.name = "NeedsHumanError";
    this.status = status;
  }
}

/**
 * A stable per-install device id. Eufy binds the auth token to it and keeps one session per id per
 * account, so it must not change between runs — and must differ from any other client on the account.
 */
function openudid(): string {
  const file = path.join(stateDir(), "openudid");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const id = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(file, id, { mode: 0o600 });
  return id;
}

export function createClient(overrides: Partial<EufyMegaOptions> = {}): EufyMega {
  const opts: EufyMegaOptions = {
    email: requireEnv("EUFY_EMAIL"),
    password: requireEnv("EUFY_PASSWORD"),
    countryCode: process.env.EUFY_COUNTRY ?? "US",
    openudid: openudid(),
    store: new FileSessionStore(sessionFile()),
    logger: new ConsoleLogger(logLevel()),
    ...overrides,
  };
  if (process.env.FFMPEG_PATH) opts.ffmpegPath = process.env.FFMPEG_PATH;
  const eufy = new EufyMega(opts);
  eufy.on("error", (err) => console.error("[eufy error]", err.message));
  eufy.on("sessionExpired", (err) => console.error("[eufy] session expired:", err.message));
  return eufy;
}

/**
 * Drive the login state machine. `interactive` prompts on the terminal for 2FA / captcha; otherwise
 * any human step raises {@link NeedsHumanError} so a daemon never loops on login (that is what earns
 * an account captchas and cooldowns).
 */
export async function login(eufy: EufyMega, interactive: boolean): Promise<void> {
  let r = await eufy.login();
  while (r.status !== LoginStatus.Ok) {
    if (!interactive) throw new NeedsHumanError(r.status);
    if (r.status === LoginStatus.Captcha) {
      const file = path.join(stateDir(), "captcha.png");
      fs.writeFileSync(file, Buffer.from(r.image.split(",")[1] ?? "", "base64"));
      const answer = await prompt(`Captcha required. Open ${file} and type the 4 characters: `);
      r = await eufy.solveCaptcha(answer.trim());
      if (r.status === LoginStatus.Captcha && r.retry) console.log("wrong captcha, try again");
    } else if (r.status === LoginStatus.TwoFactor) {
      const code = await prompt(`2FA code sent via ${r.method ?? "email/sms"}. Enter code: `);
      r = await eufy.submitVerifyCode(code.trim());
    } else {
      throw new Error(`unexpected login status: ${JSON.stringify(r)}`);
    }
  }
}

/** Convenience: build a client and log in, returning it ready to use. */
export async function connect(interactive = false): Promise<EufyMega> {
  const eufy = createClient();
  await login(eufy, interactive);
  return eufy;
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
