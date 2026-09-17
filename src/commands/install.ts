import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type AppConfig } from "../app-config.ts";
import { stateDir } from "../config.ts";
import type { GlobalOpts } from "./app.ts";

interface InstallOpts extends GlobalOpts {
  node?: string;
  print: boolean;
}

/**
 * Render the LaunchDaemon plist into EUFY_SNAP_HOME and print the sudo steps. This command itself never
 * needs privileges, and the plist carries no secrets — those stay in `<home>/env`, mode 0600.
 */
export function installCommand(opts: InstallOpts): void {
  const cfg = loadConfig(opts.config);
  const home = stateDir();
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const cli = path.join(repo, "dist", "cli.js");
  const node = opts.node ?? stableNodePath();
  const user = cfg.daemon.user ?? os.userInfo().username;
  const userHome = user === os.userInfo().username ? os.homedir() : `/Users/${user}`;
  const plist = renderPlist(cfg, { node, cli, home, user, userHome });
  const target = `/Library/LaunchDaemons/${cfg.daemon.label}.plist`;

  if (opts.print) {
    process.stdout.write(plist);
    return;
  }
  const out = path.join(home, `${cfg.daemon.label}.plist`);
  fs.writeFileSync(out, plist);
  fs.mkdirSync(cfg.paths.logs, { recursive: true });

  const problems: string[] = [];
  if (!fs.existsSync(cli)) problems.push(`${cli} does not exist — run \`npm run build\` first`);
  if (!fs.existsSync(path.join(home, "session.json"))) problems.push(`no ${path.join(home, "session.json")} — run \`eufy-snap login\` as ${user} first`);
  if (!fs.existsSync(cfg.paths.reference)) problems.push(`no ${cfg.paths.reference} — run \`eufy-snap reference\` so daily runs can verify the aim`);
  const envFile = path.join(home, "env");
  if (!fs.existsSync(envFile)) problems.push(`no ${envFile} — copy .env there (EUFY_EMAIL/EUFY_PASSWORD/EUFY_COUNTRY, plus TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID), chmod 600`);
  else if ((fs.statSync(envFile).mode & 0o077) !== 0) problems.push(`${envFile} is readable by others — chmod 600 ${envFile}`);

  const { hour, minute } = cfg.schedule.daemonStart;
  console.log(`wrote ${out}\n`);
  console.log(`Daemon "${cfg.daemon.label}" runs \`${cli} run\` as ${user} at ${pad(hour)}:${pad(minute)} daily (and at boot), with EUFY_SNAP_HOME=${home}.`);
  if (problems.length) console.log(`\nBefore installing:\n${problems.map((p) => `  • ${p}`).join("\n")}`);
  console.log(`
Install / update (needs sudo):
  sudo cp ${out} ${target}
  sudo chown root:wheel ${target} && sudo chmod 644 ${target}
  sudo launchctl bootout system/${cfg.daemon.label} 2>/dev/null; sudo launchctl bootstrap system ${target}

Check:
  sudo launchctl print system/${cfg.daemon.label} | head -20
  tail -f ${path.join(cfg.paths.logs, "eufy-snap.log")}

Fire it now (tests the whole daemon path; \`run\` waits for today's fire time or catches up):
  sudo launchctl kickstart -k system/${cfg.daemon.label}

Keep the Mac awake for it (once):
  sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1

Remove:
  sudo launchctl bootout system/${cfg.daemon.label} && sudo rm ${target}`);
}

/** Homebrew's Cellar path changes on every `brew upgrade node`; its `bin/node` symlink does not. */
function stableNodePath(): string {
  const exec = process.execPath;
  if (!exec.includes("/Cellar/")) return exec;
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    try {
      if (fs.realpathSync(candidate) === fs.realpathSync(exec)) return candidate;
    } catch {
      // not there
    }
  }
  return exec;
}

function renderPlist(cfg: AppConfig, p: { node: string; cli: string; home: string; user: string; userHome: string }): string {
  const { hour, minute } = cfg.schedule.daemonStart;
  const pathEnv = [path.dirname(p.node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter((v, i, a) => a.indexOf(v) === i).join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${x(cfg.daemon.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${x(p.node)}</string>
    <string>${x(p.cli)}</string>
    <string>run</string>
  </array>
  <key>UserName</key>
  <string>${x(p.user)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${x(pathEnv)}</string>
    <key>EUFY_SNAP_HOME</key>
    <string>${x(p.home)}</string>
    <key>HOME</key>
    <string>${x(p.userHome)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${x(p.home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${x(path.join(cfg.paths.logs, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${x(path.join(cfg.paths.logs, "launchd.err.log"))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function x(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
