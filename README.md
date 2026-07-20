# XPAD Mini × Claude Code

Turns a [Pulsar Lab XPAD Mini](https://www.pulsar.gg/products/pulsar-lab-xpad-mini-gaming-key-pad)
into a status display and control surface for [Claude Code](https://claude.com/claude-code),
on Windows and macOS.

- **LEDs mirror Claude's state** — a dot circles the light bar and keys
  while the agent works, flashing red when it needs you, pulsing green when
  it's done.
- **Keys** — the app maps the actions straight onto the pad: left types `y`
  (approve), right types `n` (reject), center holds **Left Ctrl+Left Win**
  (Wispr Flow's own Windows push-to-talk default — bind your dictation app
  to that combo, or to `F13` on macOS, where Ctrl+Win isn't available).
- **LCD** — Clawd the crab reacts to what's happening: typing while Claude
  works, celebrating on completion, sleeping when idle.

## Status

Working end-to-end on Windows with real hardware: Claude Code hooks drive the
LEDs and LCD live over Pulsar's vendor HID protocol (SayoDevice "API v2",
reverse-engineered and documented in [docs/PROTOCOL.md](docs/PROTOCOL.md)).
All device writes are RAM-only — unplugging the pad restores its factory
behavior. macOS support is implemented but untested. Installers are unsigned:
on Windows, SmartScreen needs "More info → Run anyway"; on macOS, right-click
→ Open the first time.

## Setup

1. Install and launch the app (tray icon appears; settings open on first run).
2. Click **Install hooks** — this merges hook entries into
   `~/.claude/settings.json` so Claude Code reports its lifecycle events to
   the app. **Uninstall hooks** removes them cleanly.
3. That's it — while the app runs, it maps the key actions directly onto the
   pad over the vendor protocol, RAM-only: the pad itself types `y` / holds
   Ctrl+Win / types `n`, with zero added latency. Unplugging restores the
   factory keymap; the app re-applies on reconnect. (To use the pad without
   the app, you can still remap permanently: hold the volume knob ~2 s →
   Keymap, or Pulsar's Bibimbap web driver at `bbb.pulsar.gg`.) Key actions
   aren't exposed in the settings UI — edit `config.json` in the app's data
   directory if you want different ones.
4. Optional: adjust LED colors/effects and brightness in the settings UI.

## Development

```sh
npm install
npm run gen-icons   # tray icons
node tools/gen-clawd.js  # built-in procedural Clawd LCD frames
npm run dev         # run with hot reload
npm run build       # production build into out/
```

### Optional: pixel-art Clawd animations

The LCD can play the lovely pixel-art Clawd animations from
[KebeliSamet0/clawd](https://github.com/KebeliSamet0/clawd):

```sh
node tools/import-clawd-gifs.js
```

This downloads the GIFs and converts them into `assets/clawd-external/`
(gitignored) and into a per-user directory (`%APPDATA%\xpad-mini-claude-code\
clawd-external` on Windows, `~/Library/Application Support/xpad-mini-claude-code/
clawd-external` on macOS) that installed builds read too — so the import
survives app updates and reinstalls. **That artwork is All-Rights-Reserved
fan art of Anthropic's Clawd** — it is imported locally for personal use only
and must never be committed or redistributed with this project. Without the import, the app uses
its built-in (original, committed) procedural animations. Note that a locally
built installer (`npm run dist`) bundles `assets/` — including the imported
art — so never share locally built installers; the CI/release builds contain
only the procedural set.

## How it works

1. The app runs in the tray and serves HTTP on `127.0.0.1:3939`.
2. "Install hooks" merges hook entries into `~/.claude/settings.json` that
   `curl` each Claude Code lifecycle event (`UserPromptSubmit`, `PreToolUse`,
   `Notification`, `Stop`, ...) to the app.
3. A per-session state machine aggregates sessions into one state
   (attention > working > done > idle) that drives the tray icon, LEDs, and LCD.
4. Pad keys are remapped on the device to F13/F14/F15; the app registers them
   as global shortcuts and performs the configured action. Approve/Reject only
   fire when the focused app is a terminal/IDE from the allowlist.

## Device

Pulsar Lab XPAD Mini: VID `0x3710`, PID `0x2507`. 3 magnetic keys, volume
knob, 2 tactile buttons, 10 backlight + 3 key RGB LEDs, 240×135 LCD
(marketing says 136; the firmware reports 135).
Configured officially via Pulsar's Bibimbap web driver (`bbb.pulsar.gg`, the
`/sKey` Flutter app).
