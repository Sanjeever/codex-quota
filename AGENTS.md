# AGENTS.md

## Project

Codex Quota is an unofficial local Tauri v2 tray/menu bar app for viewing Codex quota from an authenticated ChatGPT Web session.

- Repository: `codex-quota`
- App name: `Codex Quota`
- UI language: English
- Stack: Tauri v2, Rust, TypeScript, Vite, React, pnpm
- Package manager: pnpm only
- Node.js: >= 20
- Supported OS targets: Windows and macOS only

The Tauri version is a new runtime. Do not read, migrate, convert, or delete any old Electron data, including Electron sessions, cookies, `electron-store`, cache, last snapshots, or settings. First Tauri launch should require ChatGPT login again.

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
pnpm release:bump <version>
```

## Important Files

- `src-tauri/src/lib.rs`: Tauri builder, plugins, commands, refresh flow, timers, state updates.
- `src-tauri/src/app_state.rs`: runtime constants and app state.
- `src-tauri/src/chatgpt.rs`: ChatGPT WebView session probe and usage fetch via page `eval`.
- `src-tauri/src/windows.rs`: debug/auth/hidden WebView windows and navigation restrictions.
- `src-tauri/src/tray.rs`: tray icon, macOS title, Windows tooltip, tray menu actions.
- `src-tauri/src/usage.rs`: usage response parsing, mapping, status classification.
- `src-tauri/src/time.rs`: fixed English reset and last-updated formatting.
- `src-tauri/src/summary.rs`: copied quota summary and in-memory usage change formatting.
- `src-tauri/src/debug.rs`: Debug details payload and copied JSON redaction.
- `src-tauri/src/tests.rs`: parser/status/time/summary/redaction unit tests.
- `src-tauri/capabilities/debug.json`: local Debug window command/event capability.
- `src/renderer/src/main.tsx`: Debug details React window.
- `src/shared/types.ts`: renderer-only TypeScript types.
- `scripts/bump-version.mjs`: release version bump script for all version files.
- `scripts/generate-icons.mjs`: generated original app/tray assets and Tauri icons.
- `build/icon-source/codex-quota.svg`: original vector icon source.
- `.github/workflows/ci.yml`: main/PR lint and test workflow.
- `.github/workflows/build-release.yml`: tag-triggered Tauri release build.

## Security Boundaries

- Do not ask users to paste cookies, bearer tokens, curl commands, API keys, or login credentials.
- Do not show, persist, or log tokens, raw cookies, Authorization headers, raw request headers, or raw responses.
- Do not include account identifiers in copied summary text.
- `Copy JSON` must redact `userId` and `accountId`, and mask email addresses.
- Do not write persistent log files containing request data.
- ChatGPT login state lives only in Tauri WebView storage for the Tauri app.
- Persist only Tauri app settings and last successful sanitized usage snapshot:
  - `refreshIntervalMinutes`
  - `launchAtLogin`
  - `lastKnownUsage`
  - `lastUpdatedAt`
- Remote ChatGPT windows must not receive Tauri command/plugin permissions.
- The local Debug window gets only the commands/events it needs:
  - `get_debug_state`
  - `refresh_now`
  - `copy_json`
  - `debug_state_changed`

## Current Auth Implementation

The app opens:

```text
https://chatgpt.com/codex/cloud/settings/analytics
```

Rust creates or reuses two remote ChatGPT WebView windows:

- `auth`: visible, used for login and user-selected Analytics.
- `chatgpt-hidden`: hidden, used for background refresh.

After the user logs in, refresh runs inside the authenticated ChatGPT page runtime:

1. Ensure the page is on `/codex/cloud/settings/analytics`.
2. Read the current ChatGPT session via `/api/auth/session`.
3. Use the runtime `accessToken` only for the current request.
4. Fetch `/backend-api/wham/usage` with `Authorization: Bearer <runtime token>`.
5. Return only sanitized result fields to Rust, such as `ok`, `status`, `data`, `text`, `finalUrl`, `authenticatedSession`, and `parseError`.

The token is not returned to Rust except as a boolean probe (`hasAccessToken`), not persisted, not displayed, and not logged.

Navigation restrictions:

- Auth/hidden windows allow HTTPS navigation only to `chatgpt.com`, `chat.openai.com`, `openai.com`, and `*.openai.com`.
- Debug local external links open in the system browser.

## Product Behavior

- macOS menu bar title: `Codex 5h 96% | Weekly 36%`.
- Windows uses tray icon and compact tooltip; quota details are in the tray menu.
- Tray title stays stable; richer status details belong in the tooltip and tray menu.
- Windows tray tooltip and menu width are constrained. Keep Windows-facing tray copy compact and put full detail in `Copy summary` or Debug details.
- Full reset text should include both relative and absolute time, such as `in 2h 14m at 10:22`. Compact tray menu reset text may omit absolute time.
- `Copy summary` provides sanitized shareable quota/status text from the tray menu.
- Successful refreshes may show in-memory previous/current quota deltas for the current app run only.
- Do not persist usage history or in-memory quota deltas unless explicitly requested.
- Do not add system notifications; the app should not interrupt users.
- Do not add dashboard or launcher behavior by default. Keep the product tray-first and low-interruption.
- No floating desktop window.
- Normal and error tray icons only.
- Login/analytics window is visible only when authentication is needed or the user chooses `Analytics`.
- Auth-triggered login window auto-closes after a successful usage refresh.
- User-triggered `Analytics` window stays open.
- Debug details is a local read-only window with `Copy JSON` and `Refresh now`.
- Debug details may show local account identifiers in the window, but copied JSON must be redacted.
- Closing windows does not quit the app; only `Quit` exits.
- Use `tauri-plugin-single-instance`; second instance should focus/open Debug details.

## Usage Parsing

The usage endpoint response is validated in Rust with serde/manual checks and unknown fields are allowed.

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
- `Parse error`: invalid JSON or schema failure.

## Testing Notes

- Unit tests must not call ChatGPT.
- Tests must not require real credentials.
- Keep tests focused on parser, mapping, status classification, time formatting, summary formatting, redaction, HTTP status mapping, and in-memory comparison.
- If the real endpoint shape changes, add a Rust unit test for the new schema detail before loosening validation.

## Release Notes

- Builds are unsigned.
- No auto-update.
- No Apple notarization.
- GitHub Actions release workflow runs only on `v*` tag push.
- Release workflow builds and uploads artifacts only; lint and tests run in `.github/workflows/ci.yml` on `main` and pull requests.
- Release matrix includes only `windows-latest` and `macos-latest`.
- Release artifacts are Windows NSIS `.exe`, macOS `.dmg`, and macOS app bundle artifacts.
- Use `pnpm release:bump <version>` to update every version file before a release.
- Release commits must use the exact format `chore(release): <version>`, for example `chore(release): 1.1.4`.
- To release, commit the bump, tag `v<version>`, push `main`, then push the tag.
- Do not wait for GitHub Actions to finish after pushing the release tag; report that the workflow was triggered and stop.
