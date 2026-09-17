# eufy-snap — Design

> Status: **v0.4 — Phase 1 built** (2026-09-17). v0.1 assumed a fixed position and clock time; v0.2 was a
> seasonal *sunrise tracker* that re-aimed the camera daily. The Phase 0 spike (§10.1) showed the
> S340's pan control is press-and-hold and coarse — not steppable finely enough for a smooth
> time-lapse — so v0.3 shoots from a **fixed preset** and only tracks sunrise *time*. v0.4 records what
> Phase 1 actually shipped (§10.2) and moves all runtime files under one `EUFY_SNAP_HOME`.

## 1. Goal

Every day, at sunrise (± a configured offset) for a configured location, make sure a Eufy SoloCam S340
is sitting on a chosen preset, capture a wide-lens still, store it locally forever, and post it to a
Telegram chat. The frame is identical all year; the sun rises at a different point of it each day
(≈ 66° of azimuth swing over the year at 44°N, comfortably inside the wide lens if the preset faces
roughly ESE). Runs unattended on an always-on Mac with no user logged in.

### Decisions locked in during requirements review

| Topic | Decision |
|---|---|
| Camera | **SoloCam S340 (T8170)** "the shore", `T8170TXXXXXXXXXX`, standalone Wi‑Fi (no HomeBase), battery + solar. Reached over Eufy's P2P relay (the Mac is not on its LAN). |
| Position | **Fixed preset** — camera slot 3, "preset 4" in the Eufy app (`shoot_preset`), aimed once by the owner in the Eufy app. The tool never calls `rotate()`; it only `goto`s the preset and **verifies** it got there (§3 Presetter). |
| Preset choice | Shot from **#4**; the camera's default stays **#1** (the owner's security view, where motion tracking auto-returns). |
| Zoom | Wide lens only, 1×. |
| Time | Sunrise + configurable offset (minutes), from lat/long, via `suncalc`. |
| After the shot | `goto(1)` — return to the owner's security view (`home_preset`). |
| Storage | Local folder on the Mac, keep everything, JSON sidecar per photo. |
| Delivery | Post each day's photo to a **Telegram bot** chat; failures also go there, so silence is meaningful. |
| Runtime | macOS **LaunchDaemon** (works logged-out), dedicated service user. |
| Account | Dedicated secondary Eufy account, camera shared to it. |
| Language | TypeScript / Node 24 (dictated by the SDK). |

### Non-goals (v1)

Moving the camera, video, motion events, web UI, multiple cameras, cloud storage, weather-aware skipping.

## 2. Landscape & constraints (verified 2026-09-16)

| Fact | Consequence |
|---|---|
| Eufy has **no official API**; everything is reverse-engineered from the app. | Expect breakage on Eufy updates. Fail loud, pin versions, make the SDK easy to upgrade. |
| `bropat/eufy-security-client` + `eufy-security-ws` were **archived Sept 2026**; development moved to [`@mega-yfue/eufy-sdk`](https://github.com/mega-yfue/eufy-sdk) (v0.1.2, Apache-2.0, Node ≥ 24.5, ffmpeg for live JPEGs). | Build on `@mega-yfue/eufy-sdk`. Young, but the only maintained path and it speaks the current "mega/v6" cloud. |
| SDK has **persistent sessions** (`FileSessionStore`); restored sessions need no re-auth. ✅ Verified: second run restored without 2FA. | One-shot process per day; only the first `login` is interactive. |
| One session per device identity per account; a second client evicts the first. | Dedicated account + a fixed `openudid` so the tool is one stable "device". |
| **PTZ writes are fire-and-forget, no ack**, and on the S340 `ptz.rotate()` is a *press-and-hold keep-alive*, not a step (§10.1). `preset.goto()` **can silently fail** (observed from the far end-stop). | Never trust a move. Verify the frame against a stored reference and retry; alert if still off. |
| `camera.snapshotLive()` is the fresh-frame path; each stream wakes the camera and costs battery. Cold snapshot 5–8 s; frame size **varies** (1280×720, 2304×1296, 2880×1616) with stream state. | One short session per day. Accept a frame only above a configured minimum width, else re-shoot after a short wait. |
| Back-to-back P2P sessions can hit `P2P connect timeout` until the camera releases the previous one (~15–20 s). | Retry connect with a 20 s backoff; never run two sessions concurrently (lock file). |
| S340 exposes **10 preset slots** (`list()` returns all; occupied = `raw.enable === 1`, default = `raw.isdefault === 1`) and auto-returns to the default preset after a motion-tracking event on a firmware timer with no user setting. | Shoot from #4, return to #1. Motion tracking can move the camera off #4 between `goto` and the shot; verification catches it. |
| S340 pan range ≈ 355° with hard end-stops; commands into a stop are silently dropped. | Irrelevant to a preset design, except that `goto` from a stop failed once — hence verify + retry. |

## 3. Architecture

```mermaid
flowchart LR
    subgraph mac["Always-on Mac (logged out)"]
        ld["launchd LaunchDaemon\nStartCalendarInterval 04:00\n+ RunAtLoad"] -->|"start"| run["eufy-snap run\n(Node 24, one-shot)"]
        cfg["$EUFY_SNAP_HOME/config.yaml"] --> run
        env["$EUFY_SNAP_HOME/env (600)\nEUFY_*, TELEGRAM_*"] --> run
        sess["$EUFY_SNAP_HOME/session.json (600)"] <--> run
        ref["$EUFY_SNAP_HOME/reference.jpg\n(frame at the preset)"] --> run
        run --> sun["suncalc\nsunrise time"]
        run --> ff["ffmpeg"]
        run --> store["$EUFY_SNAP_HOME/photos/\nYYYY/YYYY-MM-DD.jpg + .json"]
        run --> tg["Telegram Bot API\nsendPhoto / sendMessage"]
        run --> logs["logs/"]
    end
    run <-->|"HTTPS: auth, device list"| cloud["Eufy cloud"]
    run <-->|"P2P (relay): preset goto, livestream"| cam["SoloCam S340"]
```

### Components

| Component | Responsibility |
|---|---|
| **CLI `eufy-snap`** | `login` (interactive 2FA/captcha), `devices`, `presets` (list / goto / set-default), `reference` (goto preset, snapshot, store as `reference.jpg`), `plan [date]` (print sunrise and fire time), `snap` (do the full sequence now), `run` (daemon entrypoint: wait for today's fire time then snap), `install` (write + load LaunchDaemon), `doctor`. Spike-only commands (`rotate`, `sweep`, `watch`, `sequence`) stay behind a `dev` group. |
| **Sun model** | `suncalc`: sunrise for `location` on a date. `plan(date) → {sunrise, fireAt}`. |
| **Presetter** | `goto(shoot_preset)` → settle → `snapshotLive()` → `frameShift(reference, frame)`; on-preset if `|shift| < max_shift` and `mad < max_mad`. If off: `goto` again with a longer settle and re-shoot (once). Still off → keep the frame, flag `off_preset`, alert. Finally `goto(home_preset)` (best effort; failure is logged, not fatal). |
| **Capturer** | `snapshotLive()` with retries; re-shoot if `width < min_width` (stream still low-res). |
| **Frame compare** | `src/frame-shift.ts`: both frames to 320×180 grey, brute-force horizontal MAD search. Good enough for "same view / moved / how much"; not general registration. |
| **Store** | `photos/YYYY/YYYY-MM-DD.jpg` + sidecar `.json` (sunrise UTC/local, fireAt, actual shot time, width×height, shift vs reference, retries, `off_preset`, camera FW, SDK version, duration). |
| **Telegram** | On success: `sendPhoto` with caption `2026-09-16 · sunrise 06:31 · shot 06:36`. On `off_preset`: same photo, caption prefixed ⚠️. On failure: `sendMessage` with the error class and a hint (e.g. "run `eufy-snap login`"). |
| **Scheduler** | LaunchDaemon: `StartCalendarInterval` pre-dawn (default 04:00 local) plus `RunAtLoad`. `run` computes today's `fireAt`; if in the future, sleeps until then (wall clock, not a monotonic timer, to survive system sleep); if already passed and today's photo is missing → catch-up snap; otherwise exit. Lock file prevents overlap. |

## 4. Daily sequence

```mermaid
sequenceDiagram
    participant L as launchd
    participant R as eufy-snap run
    participant C as Eufy cloud
    participant K as S340 (P2P relay)
    participant T as Telegram

    L->>R: 04:00 (or on load)
    R->>R: plan(today) → fireAt
    R->>R: sleep until fireAt (wall-clock)
    R->>C: login() from session store
    R->>C: getDevice(serial)
    R->>K: preset.goto(shoot_preset = 3)
    R->>R: settle
    R->>K: snapshotLive() → JPEG
    R->>R: frameShift(reference, JPEG)
    alt off-preset
        R->>K: preset.goto(shoot_preset)
        R->>R: settle × 2
        R->>K: snapshotLive()
    end
    R->>R: write photo + sidecar
    R->>K: preset.goto(home_preset = 1)
    R->>T: sendPhoto(caption)
    R->>R: exit 0
```

Degraded paths:
- Snapshot fails after retries → Telegram error, exit 30.
- Session needs a human (2FA/captcha) → Telegram "needs login", exit 10, **no login retry loop** (that is what triggers Eufy captchas/cooldowns).
- Off-preset after retry → photo kept and posted with ⚠️, sidecar `off_preset: true`, exit 20.
- Return `goto(home_preset)` fails → logged and noted in the caption; motion tracking's own auto-return will bring it back to #1 eventually.
- P2P connect timeout → wait 20 s, retry up to 3×.

## 5. Configuration

Everything the tool reads or writes lives under **`EUFY_SNAP_HOME`** (default `~/.eufy-snap`, mode 0700):

```
config.yaml   env (0600)   session.json   openudid   reference.jpg (+ .json, .prev.jpg)
photos/YYYY/YYYY-MM-DD.jpg + .json     logs/eufy-snap.log, launchd.*.log     run.lock
com.eufysnap.daily.plist  (rendered by `install`)
```

The authoritative, commented template is [`config.example.yaml`](../config.example.yaml); abridged:

```yaml
# $EUFY_SNAP_HOME/config.yaml — no secrets in this file
location:
  lat: 43.6231
  lon: -70.2078
  timezone: America/New_York

camera:
  serial: T8170TXXXXXXXXXX
  shoot_preset: 3               # camera slot aimed at the sunrise (app "preset 4"; the app counts from 1, the camera from 0)
  home_preset: 1                # camera's default / security view; returned to after the shot
  settle_ms: 6000               # after goto, before shooting

schedule:
  sunrise_offset_min: 5         # negative = before sunrise
  daemon_start: "04:00"         # pre-dawn launchd trigger; must precede earliest sunrise+offset
  catch_up_max_min: 180         # daemon started late? still shoot if within this many minutes of fire time

capture:
  retries: 3
  min_width: 1920               # re-shoot if the stream is still delivering 720p
  min_width_wait_ms: 4000
  verify:
    max_shift: 0.03             # fraction of frame width vs reference.jpg
    max_mad: 25                 # grey-level MAD; lighting changes raise this, so keep it loose

store:
  dir: photos                   # relative to EUFY_SNAP_HOME

daemon:
  label: com.eufysnap.daily
  # user: eufysnap              # defaults to the installing user

telegram:
  chat_id_env: TELEGRAM_CHAT_ID
  bot_token_env: TELEGRAM_BOT_TOKEN
```

```
# $EUFY_SNAP_HOME/env  (0600) — read by the tool at startup; the plist only sets PATH and EUFY_SNAP_HOME
EUFY_EMAIL=...
EUFY_PASSWORD=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

`reference.jpg` is written by `eufy-snap reference` (goto `shoot_preset` → settle → snapshot → goto `home_preset`) and should be
re-taken whenever the owner re-aims the preset (the previous one is kept as `reference.prev.jpg` and the
shift between them printed). A daytime reference compares better than a dawn one; the verifier ignores
the top 10 % (sky) and bottom 30 % (near field) of the frame.

**Preset numbering.** The Eufy app shows presets 1–4; the camera stores them in slots 0–3. Config uses
**camera slots**: the owner's "preset 4" is `shoot_preset: 3`; the camera's default (app "preset 2")
is `home_preset: 1`.

## 6. Authentication

1. Create the dedicated Eufy account; from the main account share the camera to it.
2. `eufy-snap login` once, as the user the daemon will run as — handles 2FA and captcha interactively,
   writes `session.json` (0600). `openudid` is pinned in `$EUFY_SNAP_HOME/openudid` so the tool is one
   stable device identity.
3. Daily runs restore the session. If Eufy rejects it and the SDK cannot self-heal, `run` exits 10 and
   posts to Telegram.

## 7. macOS deployment

- Runs as the installing user by default (`daemon.user` overrides — a dedicated `eufysnap` account is
  still the tidier choice on a shared Mac). Node 24 + ffmpeg via Homebrew; the plist sets an explicit
  `PATH` because daemons have none, and prefers `/opt/homebrew/bin/node` over the version-pinned Cellar path.
- `/Library/LaunchDaemons/<label>.plist`: `UserName`, `RunAtLoad true`, `StartCalendarInterval` from
  `schedule.daemon_start`, `EnvironmentVariables {PATH, EUFY_SNAP_HOME, HOME}` only — **no secrets**;
  the tool reads `$EUFY_SNAP_HOME/env` itself. stdout/stderr to `$EUFY_SNAP_HOME/logs/`.
- `eufy-snap install` needs no privileges: it renders the plist into `EUFY_SNAP_HOME`, checks for the
  build, session, reference and env file, and prints the `sudo cp` / `launchctl bootstrap system` /
  `kickstart` / `pmset` commands for the owner to run. It never edits `/Library` itself.
- `RunAtLoad` + `run`'s own logic make the daemon idempotent: at boot or install time it either sees
  today's photo and exits, waits for `fireAt`, catches up if within `catch_up_max_min`, or alerts and skips.
- `sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1` so a logged-out Mac stays awake.
- `doctor` (Phase 2) will verify Node/ffmpeg, session validity, P2P reachability, presets occupied,
  `reference.jpg` present, store dir writable, daemon loaded, Telegram reachable.

## 8. Observability

- One line per event with ISO timestamp, level and run id, mirrored to `logs/eufy-snap.log`; a JSON
  sidecar per photo (see `Sidecar` in `src/store.ts`); Telegram is the human-facing channel.
- Exit codes: `0` ok · `10` auth needs human · `20` off-preset (photo taken) · `30` capture failed · `40` store/telegram failed.
- Every photo is compared to the reference, so mount drift or a re-aimed preset shows up the same day.

## 9. Security

No secrets in repo or `config.yaml`. `env`, `session.json` 0600. Photos are of your property — they stay
on the Mac; the Telegram chat should be private. Pin the SDK to an exact version; upgrade via `snap` test first.

## 10. Delivery phases

| Phase | Scope | Exit criterion |
|---|---|---|
| **0 — Spike** ✅ | `login`, `devices`, `presets`, `rotate`, `snapshotLive`, `sequence`, `sweep` against the real S340. | Done 2026-09-16; findings in §10.1. |
| **1 — MVP** ✅ built | Sun model, `plan`, `reference`, Presetter (goto + verify), `snap`, `run` with wait/catch-up, lock file, local store + sidecars, Telegram photo/alerts, LaunchDaemon `install`. | Code complete 2026-09-17 (§10.2). **Still to prove:** runs unattended for 3 consecutive sunrises. |
| **2 — Hardening** | Telegram bot actually configured, forced-failure drills, `doctor`, log rotation, retention policy. | A forced failure (wrong password) produces a Telegram alert, no login loop. |
| **3 — Later** | Time-lapse assembly script (`ffmpeg` glob → mp4), weather skip, multiple cameras, tilt/pan re-aim if the SDK ever gains a stop command. | — |

### 10.1 Phase 0 findings (S340 `T8170TXXXXXXXXXX`, firmware as of 2026-09-16)

- **Login / session**: 2FA once, then `session.json` restores with no network auth. Two S340s on the
  account; both report `PTZ BATTERY CAMERA RTSP ZOOM PRESETS` (the `RTSP` flag is unexpected for a
  battery cam — unverified, not relied on).
- **Connectivity**: the Mac is not on the camera's LAN; P2P goes via Eufy relay in ~3 s (LAN attempts
  to the camera's private IP fail with `EHOSTUNREACH`, harmless noise). Starting a new session
  within ~15 s of the last one → `P2P connect timeout`.
- **Snapshot**: `snapshotLive()` cold ≈ 5–8 s (relay). Returned 1280×720, 2304×1296 and 2880×1616 on
  different calls — the JPEG is whatever keyframe the stream is on. Wide lens by default.
- **Presets**: `list()` returns 10 slots; owner's slots 0–3 occupied, **#1 is default**. `goto(1)`
  worked repeatedly from nearby positions but **silently did nothing** when the camera was parked
  at the far (right) end-stop — four consecutive attempts, no error, no movement. Root cause
  unknown (firmware refusal at the stop? long-travel goto being cancelled?). ⇒ verify + retry.
- **Rotate**: `rotate()` is **not a step**. 1, 2, 3 or 4 commands (200–2000 ms apart) never moved the
  camera, nor did 6 commands 200 ms apart; bursts of 6 at 600 ms moved it ≈ 85° (more than half the
  wide frame), and ~25 commands swept the full ≈ 355° range in both directions. Consistent with the
  app's press-and-hold: the camera moves while a keep-alive stream of sufficient length arrives, and
  the SDK exposes no stop (`cmd_type: 0`) to shorten a burst. The `zoom` argument (claimed to scale
  step size) made no difference at 1 vs 4. Speed 1/3/5 untested.
  **Conclusion: no fine positioning available → fixed-preset design.**
- **End-stops**: pan is ≈ 355° with hard stops; commands into a stop are dropped silently and
  `ptzNotify` does not flag it (`{"kind":"rotate","payload":{"limit":0}}` throughout).
- **Position feedback**: none. `ptzNotify` on the S340 carries only `{limit}` on rotate and
  `{dstZoom}` on stream start — no pan/tilt angles. Hence image-based verification.
- **Idle behaviour**: a manually moved camera stayed put for ≥ 2 min with no motion event — the
  firmware auto-return is tied to motion tracking, not to idle time.

### 10.2 Phase 1 test results (2026-09-17, midday)

- `reference` then three `snap`/`run` shots over ~5 min, each a fresh P2P session: `goto(3)` from
  slot 1 landed identically every time — verify **shift 0.0 %, MAD 9.5 / 10.2 / 10.4** against the
  reference. The `goto` failure seen in Phase 0 has not recurred from the home preset.
- Each run: ~18 s wall clock. First `snapshotLive` frame is 1280×720; the second (4 s later) is
  1920×1080 — `min_width: 1920` is met on attempt 2 every time. Larger frames (2304/2880) were not
  seen in these runs; the S340 appears to serve 1080p to a relay session at this hour.
- `run` branches exercised with `--at`: skip (photo exists), wait (fired within 1 s of the target),
  catch-up (11 min late → `reason: catch-up`), missed window (546 min late → alert path, exit 1).
  Concurrent `run` rejected by the lock (`run.lock` holds the pid; stale locks are reclaimed).
- Return to slot 1 succeeded every time (`returnedHome: true`).
- Firmware version is not exposed by the SDK's `Device`; the sidecar's `camera.firmware` stays absent.

## 11. Remaining open items

1. **Aiming.** ✅ Done: owner saved app "preset 4" (camera slot 3) aimed at the sunrise sector
   (≈ 57°–123° true over the year at the shore); `reference.jpg` captured from it; return to
   slot 1 (the camera's default). Owner should eyeball `reference.jpg` once to confirm the framing.
2. **`goto` failure mode.** Not reproduced in Phase 1 (4/4 from slot 1). Still worth one experiment
   from an end-stop with a 20 s settle. Low stakes because the camera lives on slot 1, which is not
   at the far stop.
3. **Motion tracking at shot time.** If a tracking event is in progress at `fireAt`, the frame is
   off-preset; the verifier retries once after settle × 2. Is one retry enough, or wait up to N minutes?
4. **Frame size policy.** Phase 1 consistently got 1920×1080 on the second attempt (4 s). If dawn
   sessions serve 2304/2880 (as the spike saw), raising `min_width` would trade a longer stream for a
   bigger frame — decide after a few real sunrises.
5. **Battery budget**: one ~20–40 s stream per day is fine on solar; confirm through winter.
6. **Location precision**: lat/lon to ~0.01° is plenty; timezone must be the IANA name for DST.
7. **Upstream**: worth filing with the SDK — S340 `rotate()` needs a keep-alive stream, and a
   `stop`/`cmd_type: 0` would make fine moves possible (re-opens the tracking design as Phase 3).
8. **Telegram bot.** Not yet created. `env` needs `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`; until then
   `snap`/`run` save locally and skip delivery silently. Test with `snap` before relying on daily posts.
9. **Retention.** Photos are kept forever by design (~170 KB/day ≈ 60 MB/year at 1080p). Logs are
   appended without rotation — add `newsyslog` or a size cap in Phase 2.
