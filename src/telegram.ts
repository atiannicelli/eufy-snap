import { warn } from "./log.ts";

export interface TelegramTarget {
  token: string;
  chatId: string;
}

/** Resolve the bot from env; `undefined` means Telegram is not configured and delivery is skipped. */
export function telegramFromEnv(botTokenEnv: string, chatIdEnv: string): TelegramTarget | undefined {
  const token = process.env[botTokenEnv];
  const chatId = process.env[chatIdEnv];
  if (!token || !chatId) return undefined;
  return { token, chatId };
}

async function call(t: TelegramTarget, method: string, body: FormData | URLSearchParams): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${t.token}/${method}`, { method: "POST", body, signal: AbortSignal.timeout(30_000) });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!res.ok || json.ok !== true) throw new Error(`telegram ${method} failed: HTTP ${res.status} ${json.description ?? ""}`.trim());
}

export async function sendPhoto(t: TelegramTarget, jpeg: Buffer, caption: string, filename = "sunrise.jpg"): Promise<void> {
  const form = new FormData();
  form.set("chat_id", t.chatId);
  form.set("caption", caption.slice(0, 1024));
  form.set("photo", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), filename);
  await call(t, "sendPhoto", form);
}

export async function sendMessage(t: TelegramTarget, text: string): Promise<void> {
  await call(t, "sendMessage", new URLSearchParams({ chat_id: t.chatId, text: text.slice(0, 4096) }));
}

/** Best-effort notify: a Telegram outage must not change the run's outcome. */
export async function notify(t: TelegramTarget | undefined, text: string): Promise<boolean> {
  if (!t) return false;
  try {
    await sendMessage(t, text);
    return true;
  } catch (e) {
    warn("telegram message failed", { error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}
