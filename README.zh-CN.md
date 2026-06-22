# Codex Quota

[English](README.md) | [简体中文](README.zh-CN.md)

非官方本地 Tauri v2 托盘应用。通过已登录的 ChatGPT Web 会话查看 Codex quota。

协议：[MIT](LICENSE)。

不需要 API key。不要求粘贴 cookie。不输入 bearer token。不收集登录凭据。

ChatGPT 登录状态只存在 Tauri WebView 存储里。首次启动 Tauri 版需要重新登录 ChatGPT。旧 Electron 数据不读取、不迁移、不删除：session、cookie、`electron-store`、缓存、快照、设置。

使用 ChatGPT Web 内部接口 `/backend-api/wham/usage`。接口可能变化。结构变更时，应用显示 API/解析错误，不猜测 quota。

## 截图

![Codex Quota macOS 菜单栏截图](screenshot.png)

## 功能

- macOS 菜单栏标题：`Codex 5h 96% | Weekly 36%`。
- Windows 托盘图标 + 精简 tooltip。详情在托盘菜单。
- `Copy summary`：复制精简、脱敏的 quota 文本。
- Debug details：本地账号信息、quota 详情、脱敏 JSON、刷新按钮。
- 复制 JSON 时会隐藏账号 ID，并遮罩邮箱。
- 隐藏的已登录 ChatGPT WebView 支持后台刷新。
- 持久化设置：刷新间隔、开机启动、最后一次脱敏使用量快照、最后更新时间。
- 单实例：第二次启动会打开/聚焦 Debug details。
- 不使用 OpenAI/Codex 官方 logo。
- 无自动更新、签名、公证、系统通知。

## 要求

- Node.js >= 20
- Rust stable
- 只用 pnpm

## 安装

```bash
pnpm install
```

## 运行

```bash
pnpm dev
```

首次运行：

1. 应用启动托盘/菜单。
2. 刷新尝试使用当前 Tauri WebView 会话。
3. 如未登录，状态变为 `Auth required`。
4. 应用打开 ChatGPT analytics：

```text
https://chatgpt.com/codex/cloud/settings/analytics
```

登录后，从托盘点击 `Refresh`。

Quota 变化只和本次应用运行内的上一次快照比较。例：`Change: 5h -12%, Weekly +3%`。不持久化。

## 构建

```bash
pnpm lint
pnpm test
pnpm build
```

`pnpm test` 会先生成图标，再运行 Rust 单元测试。测试不访问 ChatGPT，不需要真实凭据。

## 打包

```bash
pnpm dist
pnpm dist:win
pnpm dist:mac
```

产物未签名。Windows/macOS 可能提示风险。输出：Windows NSIS `.exe`、macOS `.dmg`、macOS app bundle。

## 发布

发布 workflow 只在 `v*` tag 上运行。

```bash
pnpm release:bump 1.2.0
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "chore(release): 1.2.0"
git tag v1.2.0
git push origin main
git push origin v1.2.0
```

发布提交格式必须是 `chore(release): <version>`。

GitHub Actions 构建 Windows + macOS 产物。CI lint/test 另在 `main` 和 PR 上运行。

## 排查

- `Auth required`：会话缺失/过期或 401/403。用 `Analytics` 或 `Reset session`。
- `Request timeout`：刷新超过 30 秒。
- `Offline`：WebView 网络失败。
- `API error`：非 2xx 响应，auth 类错误除外。
- `Parse error`：JSON/schema 变化。
- `Authenticated ChatGPT session, but usage endpoint returned unauthorized`：ChatGPT 已登录，但使用量接口拒绝运行时认证请求。

刷新失败时，如已有上次成功快照，托盘继续显示该快照并标记 stale。

不要把 token、cookie、原始 header、密钥贴进 issue。优先用 `Copy summary`。`Copy JSON` 已脱敏。

## 手动测试

1. 运行 `pnpm dev` 或打包后的应用。
2. 确认 Tauri 首次启动需要重新登录 ChatGPT。
3. 确认 auth 窗口打开 ChatGPT analytics。
4. 登录，点击 `Refresh`，确认 quota 加载。
5. 关闭 auth 窗口，确认隐藏 WebView 仍可刷新。
6. macOS：确认菜单栏标题显示 `Codex 5h ... | Weekly ...`。
7. Windows：确认托盘 tooltip/menu 保持精简。
8. 使用 `Copy summary`，确认无账号标识。
9. 打开 Debug details。确认本地 ID 可见，但 `Copy JSON` 会隐藏 `userId`/`accountId` 并遮罩邮箱。
10. 使用 `Reset session`，确认 Tauri 会话清除并重新打开登录。Electron 数据不受影响。
11. 启动第二个实例，确认 Debug details 打开/聚焦。
12. 关闭窗口，确认应用继续运行。只有 `Quit` 退出。
