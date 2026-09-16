# eufy-snap

Daily sunrise-tracking snapshots from a Eufy SoloCam S340. Design: [`docs/DESIGN.md`](docs/DESIGN.md).

**Status: Phase 0 spike.** The CLI below exists to prove login, PTZ, presets and live snapshots work
against the real camera before the scheduler and sun model are built.

## Requirements

- Node ≥ 24.5 (`node --version`)
- ffmpeg on `PATH` (`brew install ffmpeg`) — needed for `snapshot` and `sequence`
- A **dedicated Eufy account** with the camera shared to it (do not use your main account; Eufy
  allows one active session per device identity per account and will log your phone out)

## Setup

```bash
npm install
cp .env.example .env      # fill in the tool account's EUFY_EMAIL / EUFY_PASSWORD / EUFY_COUNTRY
```

Commands run directly from TypeScript (`node src/cli.ts …`) or from the build (`npm run build && node dist/cli.js …`).
`npm run dev -- <command>` is shorthand for the former.

## Phase 0 runbook

Run these in order; each answers a question from the design's spike exit criteria.

| Step | Command | What to check |
|---|---|---|
| 1 | `npm run dev -- login` | Prompts for the 2FA code sent to the tool account. Prints devices. Session saved to `~/.eufy-snap/session.json`. |
| 2 | `npm run dev -- devices` | Run **twice**: second run must not ask for 2FA (session restored). S340 shows `PTZ BATTERY CAMERA PRESETS` flags. Note the serial. |
| 3 | `npm run dev -- presets <sn>` | Lists presets stored on the camera. Save the home view in the app first (or `--save 0`). |
| 4 | `npm run dev -- rotate <sn> right 1` | Camera visibly steps once. Note any `ptzNotify` lines — that is the camera's status payload. |
| 5 | `npm run dev -- rotate <sn> right 3 --speed 3` | Confirms speed can be pinned and steps are consistent. |
| 6 | `npm run dev -- snapshot <sn>` | Fresh JPEG in `out/`. Note the time to first frame on a sleeping battery camera and the resolution (wide lens expected). |
| 7 | `npm run dev -- watch <sn> --seconds 90 --nudge` | Dumps every PTZ status frame verbatim. Also move the camera from the Eufy app during this window. Question: does any payload contain a position/angle? |
| 8 | `npm run dev -- sequence <sn> --home 0 --dir right --steps 2` | Full daily rehearsal with timings. The JPEG should show the view two steps right of home, and the camera should end at home. |
| 9 | Move the camera from the app, wait 3 minutes without motion | Does it return to the default preset on its own? Then walk past it: does it track, and how long until it returns? |

Record findings in `docs/DESIGN.md` §10 (Phase 0) before moving to Phase 1.

## Exit codes

`0` ok · `1` error · `10` login needs a human (2FA/captcha) — run `login` interactively · `30` snapshot failed

## Logging

Set `EUFY_LOG_LEVEL=debug` in `.env` to see the SDK's own diagnostics (P2P, cloud calls).
