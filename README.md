# Codex Quota

Codex Quota is an unofficial, local Tauri v2 menu bar / system tray app for viewing Codex usage quota from an already authenticated ChatGPT web session.

This Tauri version is a new app runtime. It does not read, convert, or delete any old Electron data, including Electron sessions, cookies, `electron-store`, cache, last snapshots, or settings. The first Tauri launch requires signing in to ChatGPT again.

## macOS Screenshot

![Codex Quota macOS menu bar screenshot](screenshot.png)

It does not use an API key. It does not ask you to paste cookies, bearer tokens, curl commands, or login credentials. The app opens ChatGPT in Tauri WebView windows and refreshes quota from that authenticated page runtime:

```js
fetch('/backend-api/wham/usage', {
  method: 'GET',
  credentials: 'include',
  headers: {
    Accept: 'application/json',
    Authorization: 'Bearer <runtime ChatGPT access token>'
  }
})
```

The access token is read from the already authenticated ChatGPT page runtime for the current refresh request only. It is not returned to Rust, not shown in Debug details, not persisted, and not logged. This uses an internal ChatGPT web endpoint. That endpoint may change. If it changes, Codex Quota shows a clear API or parse error instead of guessing quota from the page.

## Features

- macOS menu bar title like `Codex 5h 96% | Weekly 36%`.
- Windows system tray icon and compact tooltip, with quota details in the tray menu.
- Tray menu uses compact reset times; `Copy summary` includes both relative and absolute time, such as `in 2h 14m at 10:22`.
- `Copy summary` copies a short sanitized quota summary from the tray menu.
- Local Tauri WebView ChatGPT session, separate from any old Electron session.
- Rust-side settings persistence for refresh interval, launch at login, last successful usage snapshot, and last update time.
- Debug details window with local account details, quota details, sanitized JSON, and refresh controls.
- Copied JSON redacts account identifiers and masks email addresses.
- Single-instance behavior: launching a second instance opens/focuses Debug details.
- No OpenAI or Codex official logos.
- No auto-update, code signing, or Apple notarization.

## Install Dependencies

```bash
pnpm install
```

Node.js 20 or newer and a Rust stable toolchain are required.

## Run Locally

```bash
pnpm dev
```

On first launch, Codex Quota creates the tray/menu and attempts a refresh. If the Tauri ChatGPT WebView session is not authenticated, it shows `Auth required` and opens:

```text
https://chatgpt.com/codex/cloud/settings/analytics
```

After login, use `Refresh` from the tray menu.

Successful refreshes compare the current quota with the previous in-memory snapshot for the current app run. The app may show a line like `Change: 5h -12%, Weekly +3%`. This comparison is not written to disk and resets when the app exits.

## Build

```bash
pnpm lint
pnpm test
pnpm build
```

Generated icons are created by `pnpm dev`, `pnpm test`, and Tauri package builds before Rust needs them. `pnpm test` runs Rust unit tests for the parser/status/time/summary/redaction logic. Tests do not call ChatGPT and do not need real credentials.

## Package Installers

```bash
pnpm dist
pnpm dist:win
pnpm dist:mac
```

Build outputs are unsigned. Windows, macOS Gatekeeper, or other security tools may show warnings for local unsigned packages. Windows builds produce NSIS `.exe` installers. macOS builds produce `.dmg` and app bundle artifacts through Tauri.

## GitHub Release Builds

The release workflow runs only for version tags:

```bash
pnpm release:bump 1.2.0
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "chore(release): 1.2.0"
git tag v1.2.0
git push origin main
git push origin v1.2.0
```

`pnpm release:bump <version>` updates all project version files together. Release commits should always use the exact format `chore(release): <version>`, for example `chore(release): 1.2.0`.

The release workflow installs pnpm with Node 20, installs Rust stable, restores Rust build cache without saving a new cache, then uses the official Tauri GitHub Action to build and attach release artifacts for Windows and macOS. Lint and tests run in the separate CI workflow on `main` and pull requests.

## Errors And Troubleshooting

- `Auth required`: the Tauri ChatGPT WebView session is missing, expired, or returned 401/403. Use `Analytics` or `Reset session`.
- `Authenticated ChatGPT session, but usage endpoint returned unauthorized`: ChatGPT login is present, but the internal usage endpoint rejected the runtime-authenticated request. Codex Quota does not display raw tokens, raw cookies, or request headers in Debug details.
- `Request timeout`: the refresh exceeded 30 seconds. The app waits until the next timer or manual refresh.
- `Offline`: the WebView reported a network failure.
- `API error`: the endpoint returned a non-2xx status other than auth cases.
- `Parse error`: JSON parsing or schema validation failed. The internal endpoint may have changed.

When a refresh fails and a previous successful usage snapshot exists, the tray keeps showing that snapshot and marks it as stale in the tray menu and tooltip. The app never shows system notifications for errors.

Never paste tokens, cookies, raw request headers, or secrets into this app or into bug reports. Prefer `Copy summary` for sharing current quota state. `Copy JSON` is also sanitized: email addresses are masked and account identifiers are redacted.

## Manual Testing

1. Run `pnpm dev` or launch the packaged Tauri app.
2. Confirm first Tauri startup requires signing in again and does not reuse old Electron login state.
3. Confirm the auth window opens ChatGPT analytics.
4. Sign in, run `Refresh`, and confirm quota refresh succeeds.
5. Confirm the hidden ChatGPT WebView can refresh in the background after the auth window is closed.
6. On macOS, confirm the menu bar title shows `Codex 5h ... | Weekly ...`.
7. On Windows, confirm the tray tooltip/menu remain compact.
8. Use `Copy summary` and confirm the copied text contains quota/status details but no account identifiers.
9. Open Debug details and confirm local account identifiers are visible in the window, while `Copy JSON` redacts `userId`/`accountId` and masks email.
10. Use `Reset session` and confirm it clears the Tauri WebView session/store and opens login again without touching Electron data.
11. Launch a second instance and confirm Debug details opens/focuses.
12. Close windows and confirm the app stays running; confirm only `Quit` exits.
