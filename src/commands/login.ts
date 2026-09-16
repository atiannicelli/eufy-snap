import { connect } from "../client.ts";
import { sessionFile } from "../config.ts";

/** Interactive first-time login: handles 2FA / captcha, persists the session for unattended runs. */
export async function loginCommand(): Promise<void> {
  const eufy = await connect(true);
  const devices = await eufy.getDevices();
  console.log(`logged in — ${devices.length} device(s) visible; session saved to ${sessionFile()}`);
  for (const d of devices) console.log(`  ${d.sn}  ${d.name}`);
  await eufy.disconnect();
}
