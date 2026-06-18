# Codex Quota

Codex Quota is an unofficial, local Electron menu bar / system tray app for viewing Codex usage quota from an already authenticated ChatGPT web session.

It does not use an API key. It does not ask you to paste cookies, bearer tokens, curl commands, or login credentials. The app opens ChatGPT in an Electron persistent session partition and refreshes quota from that authenticated session:

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

The access token is read from the already authenticated ChatGPT page runtime for the current refresh request. It is not shown in Debug details and is not persisted to `electron-store`. This uses an internal ChatGPT web endpoint. That endpoint may change. If it changes, Codex Quota shows a clear API or parse error instead of guessing quota from the page.

## Features

- macOS menu bar title like `Codex 5h 96% | Weekly 36%`.
- Windows system tray icon and tooltip, with quota details in the tray menu.
- Reset times show both relative and absolute time, such as `in 2h 14m at 10:22`.
- Tray tooltip summarizes status, quota, reset times, stale state, and last update time.
- `Copy summary` copies a short sanitized quota summary from the tray menu.
- Persistent local ChatGPT session via Electron session storage.
- Local settings with `electron-store`.
- Debug details window with local account details, quota details, sanitized JSON, and refresh controls.
- Copied JSON redacts account identifiers and masks email addresses.
- No OpenAI or Codex official logos.
- No auto-update, code signing, or Apple notarization in v1.

## Install dependencies

```bash
pnpm install
```

Node.js 20 or newer is required.

## Run locally

```bash
pnpm dev
```

On first launch, Codex Quota immediately creates the tray/menu and attempts a refresh. If the ChatGPT session is not authenticated, it shows `Auth required` and opens:

```text
https://chatgpt.com/codex/cloud/settings/analytics
```

After login, use `Refresh now` from the tray menu.

Successful refreshes also compare the current quota with the previous in-memory snapshot for the current app run. The app may show a line like `Change: 5h -12%, Weekly +3%`. This comparison is not written to disk and resets when the app exits.

## Build

```bash
pnpm lint
pnpm test
pnpm build
```

Tests cover the zod usage parser, remaining-percent calculation, fixed English reset-time formatting, relative reset formatting, status classification, in-memory quota comparison, copied summary output, copied JSON redaction, parse failures, and 401/403 auth mapping. Tests do not call ChatGPT and do not need real credentials.

## Package installers

```bash
pnpm dist
pnpm dist:win
pnpm dist:mac
```

Build outputs are unsigned. Windows, macOS Gatekeeper, or other security tools may show warnings for local unsigned packages.

## GitHub release builds

The release workflow runs only for version tags:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow installs pnpm with Node 20, runs `pnpm lint`, `pnpm test`, `pnpm build`, packages with electron-builder, and attaches Windows `.exe`, macOS `.dmg`, and macOS `.zip` artifacts to the matching GitHub Release.

## Errors and troubleshooting

- `Auth required`: the ChatGPT web session is missing, expired, or returned 401/403. Use `Open analytics` or `Sign out / Reset ChatGPT session`.
- `Authenticated ChatGPT session, but usage endpoint returned unauthorized`: ChatGPT login is present, but the internal usage endpoint rejected the runtime-authenticated request. Codex Quota does not display raw tokens, raw cookies, or request headers in Debug details.
- `Request timeout`: the refresh exceeded 30 seconds. The app waits until the next timer or manual refresh.
- `Offline`: Electron reported a network failure.
- `API error`: the endpoint returned a non-2xx status other than 401/403.
- `Parse error`: JSON parsing or zod schema validation failed. The internal endpoint may have changed.

When a refresh fails and a previous successful usage snapshot exists, the tray keeps showing that snapshot and marks it as stale in the tray menu and tooltip. The app never shows system notifications for errors.

Never paste tokens, cookies, raw request headers, or secrets into this app or into bug reports. Prefer `Copy summary` for sharing current quota state. `Copy JSON` is also sanitized: email addresses are masked and account identifiers are redacted.

## Manual testing

1. Run `pnpm dev`.
2. Confirm the tray/menu appears immediately.
3. If `Auth required` appears, sign in through the visible ChatGPT analytics window.
4. Use `Refresh now` and confirm quota, account, plan, relative/absolute reset times, and stale/error state update in the tray menu.
5. Refresh a second time and confirm the in-memory quota change line appears when the quota values changed.
6. Use `Copy summary` and confirm the copied text contains quota/status details but no account identifiers.
7. Open `Debug details` and confirm local account details are visible in the window, while the JSON panel and `Copy JSON` output redact account identifiers and mask email addresses.
8. Toggle refresh interval and launch-at-login settings.
9. Use `Sign out / Reset ChatGPT session` and confirm the app clears local ChatGPT session state and opens the login window again.
