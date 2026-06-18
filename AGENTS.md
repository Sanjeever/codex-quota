# AGENTS.md

## Project

Codex Quota is an unofficial local Electron tray/menu bar app for viewing Codex quota from an authenticated ChatGPT Web session.

- Repository: `codex-quota`
- App name: `Codex Quota`
- UI language: English
- Stack: Electron, TypeScript, electron-vite, React, pnpm
- Package manager: pnpm only
- Node.js: >= 20

## Common Commands

```bash
pnpm install
pnpm dev
pnpm lint
pnpm test
pnpm build
pnpm dist
pnpm dist:win
pnpm dist:mac
```

## Important Files

- `src/main/index.ts`: Electron main process, tray/menu, windows, refresh flow, session handling.
- `src/main/chatgpt.ts`: ChatGPT page-runtime session probe and usage fetch.
- `src/main/navigation.ts`: navigation restrictions for auth and local windows.
- `src/main/constants.ts`: main-process constants and refresh interval types.
- `src/preload/index.ts`: Minimal IPC API exposed to local renderer windows.
- `src/renderer/src/main.tsx`: Debug details React window.
- `src/shared/usage.ts`: zod parser, API response mapping, status classification.
- `src/shared/time.ts`: fixed English locale reset time formatting.
- `src/shared/summary.ts`: copied quota summary and in-memory usage change formatting.
- `src/shared/debug.ts`: copied/debug JSON redaction helpers.
- `tests/usage.test.ts`: parser/status/time unit tests.
- `scripts/generate-icons.mjs`: generated original app/tray icon assets.
- `build/icon-source/codex-quota.svg`: original vector icon source.
- `.github/workflows/build-release.yml`: tag-triggered release build.

## Security Boundaries

- Do not ask users to paste cookies, bearer tokens, curl commands, API keys, or login credentials.
- Do not show tokens, raw cookies, Authorization headers, or raw request headers in Debug details.
- Do not include account identifiers in copied summary text.
- `Copy JSON` must redact `userId` and `accountId`, and mask email addresses.
- Do not write persistent log files containing request data.
- ChatGPT login state lives in Electron session storage using `persist:codex-quota-chatgpt`.
- `electron-store` is only for app settings and last successful sanitized usage snapshot.
- Renderer windows must keep:
  - `nodeIntegration: false`
  - `contextIsolation: true`
  - `sandbox: true`
- Only local app renderer windows use preload.
- ChatGPT/auth windows must not have Node permissions.

## Current Auth Implementation

The app opens:

```text
https://chatgpt.com/codex/cloud/settings/analytics
```

After the user logs in, refresh runs inside the authenticated ChatGPT page runtime:

1. Ensure the page is on `/codex/cloud/settings/analytics`.
2. Read the current ChatGPT session via `/api/auth/session`.
3. Use the runtime `accessToken` only for the current request.
4. Fetch `/backend-api/wham/usage` with `Authorization: Bearer <runtime token>`.

The token is not persisted to `electron-store`, not displayed in Debug details, and not logged.

## Product Behavior

- macOS menu bar title: `Codex 5h 96% | Weekly 36%`.
- Windows uses tray icon and tooltip; quota details are in the tray menu.
- Tray title stays stable; richer status details belong in the tooltip and tray menu.
- Windows tray tooltip text is length-constrained. Keep Windows tooltip copy compact and put full detail in the tray menu or `Copy summary`.
- Reset text should include both relative and absolute time, such as `in 2h 14m at 10:22`.
- `Copy summary` provides sanitized shareable quota/status text from the tray menu.
- Successful refreshes may show in-memory previous/current quota deltas for the current app run only.
- Do not persist usage history or in-memory quota deltas unless explicitly requested.
- Do not add system notifications; the app should not interrupt users.
- Do not add dashboard or launcher behavior by default. Keep the product tray-first and low-interruption.
- No floating desktop window.
- Normal and error tray icons only.
- Login/analytics window is visible only when authentication is needed or the user chooses `Open analytics`.
- Auth-triggered login window auto-closes after a successful usage refresh.
- User-triggered `Open analytics` window stays open.
- Debug details is a local read-only window with `Copy JSON` and `Refresh now`.
- Debug details may show local account identifiers in the window, but copied JSON must be redacted.
- Closing windows does not quit the app; only `Quit` exits.
- Use `app.requestSingleInstanceLock()`.

## Usage Parsing

The usage endpoint response is validated with zod and unknown fields are allowed.

Internal model:

- primary window maps to 5h quota.
- secondary window maps to weekly quota.
- `leftPercent = clamp(100 - used_percent, 0, 100)`.
- `credits.balance` may arrive as number, numeric string, or null; map it to `number | null`.

Status classification:

- `OK`: both remaining percentages >= 30 and no limit reached.
- `Low quota`: any remaining percentage < 30.
- `Critical quota`: any remaining percentage < 10 or `limit_reached = true`.
- `Auth required`: missing/expired auth or 401/403 where session is not authenticated.
- `Request timeout`: refresh exceeded 30 seconds.
- `Offline`: network failure.
- `API error`: non-2xx except auth cases.
- `Parse error`: invalid JSON or zod/schema failure.

## Testing Notes

- Unit tests must not call ChatGPT.
- Tests must not require real credentials.
- Keep tests focused on parser, mapping, status classification, time formatting, summary formatting, redaction, and in-memory comparison.
- If the real endpoint shape changes, add a unit test for the new schema detail before loosening validation.

## Release Notes

- Builds are unsigned.
- No auto-update.
- No Apple notarization.
- GitHub Actions release workflow runs only on `v*` tag push.
- Release artifacts are Windows `.exe`, macOS `.dmg`, and macOS `.zip`.
