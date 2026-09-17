# eufy-snap

Daily sunrise snapshot from a Eufy SoloCam S340, shot from a fixed preset, stored locally forever and
(optionally) posted to Telegram. Runs unattended on an always-on Mac as a LaunchDaemon.
Design: [`docs/DESIGN.md`](docs/DESIGN.md).

**Status: Phase 1 built and tested against the camera** (2026-09-17, `docs/DESIGN.md` §10.2). Next:
run it through a few real sunrises, then create the Telegram bot.

## How it works

Every day at `daemon_start` (04:00) launchd starts `eufy-snap run`, which computes today's sunrise for
your lat/lon, sleeps until sunrise + `sunrise_offset_min`, then:

1. `goto(shoot_preset)` — the preset you aimed at the sunrise in the Eufy app — and settle
2. grab a live frame, re-shooting until it is at least `min_width` wide
3. compare it with `reference.jpg`; if the view has shifted, `goto` again and re-shoot once
4. save `photos/YYYY/YYYY-MM-DD.jpg` + a `.json` sidecar (timings, verification, warnings)
5. `goto(home_preset)` — back to your security view
6. send the photo to Telegram (if configured), or an alert if anything failed

The S340 cannot be nudged in fine steps (see the design's §10.1), which is why a saved preset is the
aiming mechanism. **Preset numbering:** the Eufy app shows presets 1–4; the camera stores them in
slots 0–3. Config uses camera slots — app "preset 4" is `shoot_preset: 3`.

## Requirements

- Node ≥ 24.5 (`node --version`), ffmpeg on `PATH` (`brew install ffmpeg`)
- A **dedicated Eufy account** with the camera shared to it (Eufy allows one active session per
  device identity per account; using your main account logs your phone out)
- The camera aimed at the sunrise and saved as a preset in the Eufy app

## Setup

```bash
npm install && npm run build
cp .env.example .env                                # tool account's EUFY_EMAIL / EUFY_PASSWORD / EUFY_COUNTRY
cp config.example.yaml ~/.eufy-snap/config.yaml     # then edit: lat/lon, timezone, serial, presets
node dist/cli.js login                              # once; 2FA prompt; saves ~/.eufy-snap/session.json
node dist/cli.js devices                            # confirm the camera and note its serial
node dist/cli.js presets <sn>                       # confirm shoot_preset / home_preset slots are stored
node dist/cli.js reference                          # shoot from the preset → ~/.eufy-snap/reference.jpg — look at it!
node dist/cli.js plan --days 7                      # sanity-check sunrise / shoot times
node dist/cli.js snap                               # full dry run right now (saves a photo, returns home)
```

All runtime state lives under `EUFY_SNAP_HOME` (default `~/.eufy-snap`): `config.yaml`, `env`,
`session.json`, `reference.jpg`, `photos/`, `logs/`, `run.lock`. During development `node src/cli.ts …`
(or `npm run dev -- …`) runs the TypeScript directly.

## Deploy as a LaunchDaemon

```bash
cp .env ~/.eufy-snap/env && chmod 600 ~/.eufy-snap/env   # the daemon has no shell env; secrets come from here
node dist/cli.js install                                  # renders the plist, checks prerequisites, prints the sudo steps
```

Then run the printed commands (`sudo cp … /Library/LaunchDaemons/`, `sudo launchctl bootstrap system …`,
`sudo pmset …`). `install` never touches `/Library` itself. Re-run `install` + the `cp`/`bootstrap`
steps after changing `daemon_start`, the Node path, or moving the checkout.

Useful afterwards:

```bash
tail -f ~/.eufy-snap/logs/eufy-snap.log
sudo launchctl kickstart -k system/com.eufysnap.daily     # fire the daemon now (it skips if today's photo exists)
node dist/cli.js run --at 07:30 --no-telegram             # rehearse the wait/shoot path at a chosen time
```

`run` is idempotent: it exits if today's photo exists, waits if it is early, catches up if it is late by
less than `catch_up_max_min`, and alerts + skips beyond that. A second concurrent `run` is rejected by
`run.lock`.

## Commands

| Command | Purpose |
|---|---|
| `login` | Interactive first-time login (2FA/captcha). Persists the session. |
| `devices` | List devices and capabilities. |
| `presets <sn>` | List camera preset slots; `--goto/--save/--set-default/--image`. |
| `reference` | Capture the verification frame from `shoot_preset`; keeps the previous as `reference.prev.jpg`. |
| `plan [date] [--days n]` | Sunrise and shoot time for a date; warns if a day fires before `daemon_start`. |
| `snap [--no-telegram]` | Shoot now. |
| `run [--at HH:MM] [--no-telegram]` | Daemon entry point: wait / catch up / skip, then shoot. |
| `install [--print] [--node path]` | Render the LaunchDaemon plist and print the activation steps. |
| `dev …` | Phase 0 spike tools: `rotate`, `snapshot`, `watch`, `sequence`, `sweep`. |

Global `-c, --config <file>` overrides `$EUFY_SNAP_CONFIG` / `~/.eufy-snap/config.yaml`.

## Exit codes

`0` ok · `1` error / skipped · `10` login needs a human (2FA/captcha) — run `login` interactively ·
`20` photo taken but the camera appears off-preset · `30` no usable frame · `40` photo saved but
Telegram delivery failed

## Logging

Runs log one line per event to stdout and `~/.eufy-snap/logs/eufy-snap.log`. `EUFY_LOG_LEVEL=debug`
adds per-frame detail and the SDK's own P2P/cloud diagnostics. The `EHOSTUNREACH` lines the SDK prints
when the Mac is not on the camera's LAN are harmless — the relay path is used.
