# dsh-mcp-manage

[English](#english) | 中文

DSH（DeepSeek Harness）Web GUI 的 MCP 管理插件：在 **设置 → MCP 管理** 页面里查看、添加、修改、删除、启用/停用 MCP 服务器——即时生效，无需重启宿主，也无需修改任何 dsh 源码。

![DSH 版本](https://img.shields.io/badge/DSH-0.1.0--rc.6-blue) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 功能

- **查看所有已安装的 MCP 工具**：每个服务器以“N 个工具”可点击计数展示，点击展开/收起工具列表（`mcp__名称__*`），默认隐藏。
- **添加**：支持 `stdio`（本地命令 + 参数 + 环境变量 + 工作目录）与 `streamable-http`（URL + 附加请求头）两种传输；保存后立即加载为运行实例，工具马上注册到会话。
- **修改**：编辑任意字段后自动以新配置重启该实例。
- **删除**：卸载运行实例并删除持久化记录。
- **启用 / 停用**：一键开关。停用立即卸载；启用立即加载。对**组合配置提供的 MCP**（cordis.yml / patch 中的行，如 cebridge）同样生效：停用/移除立即生效、可随时恢复，覆盖状态持久化并在宿主重启后自动维持（源组合文件不会被修改）。
- **持久化**：记录与覆盖保存在 `$DSH_HOME/mcp-manage/servers.json`，宿主重启后自动恢复所有已启用的服务器并维持组合覆盖。
- **启动失败可见**：默认 `failOnStartupError`，坏定义会显示“启动失败”及错误信息，而不是静默后台重试。

## 安装

```sh
dsh plugin --profile web add link:<本仓库路径>
# 或发布后：
dsh plugin --profile web add dsh-mcp-manage
```

然后重启 `dsh web`，打开 **设置 → MCP 管理**。

要求：DSH ≥ `0.1.0-rc.6`（组合中已包含 `@deepseek-ai/dsh-web-app`）。

## 卸载

```sh
dsh plugin --profile web remove dsh-mcp-manage
```

管理页删除所有记录后，`$DSH_HOME/mcp-manage/` 可以安全移除。

## 工作原理

- **host 半**（`src/index.ts` + `src/host/`）：在 `ctx.webServer` 上注册 `/api/dsh-mcp-manage/*` 路由族；每个启用的记录通过 `ctx.plugin()` 加载为一个 `@deepseek-ai/dsh-mcp-client` 实例（作为本插件 fiber 的 effect 作用域子节点，插件卸载时自动清理）。`@deepseek-ai/dsh-mcp-client` 从运行中的 dsh 安装解析（可选 peer 依赖），本插件自身不携带它。组合行管理走 Loader 的 `Entry.update` / `group.remove`（**绕过 `tree.write()`**，不物化、不修改源组合文件），覆盖状态存于本插件存储，通过 `loader/entry-init` / `loader/config-update` 钩子与列表读取时的收敛式强化在启动与热重载后自动重建。
- **client 半**（`src/client/`）：通过 `dsh.client` 声明加载到 Web GUI，向 `settings.section` 槽位注册 "MCP 管理" 导航页，纯 `fetch` 与 host 半通信。
- 工具枚举读取 `ctx.tools.schemas()` 中所有 `mcp__*` 前缀的名字，按 `serverName` 分组——这就是“当前宿主已安装的全部 MCP 工具”的权威列表。

## 开发

```sh
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest 单元测试（store 校验 / 往返）
pnpm run build       # tsc 声明 + tsdown（lib/index.js + lib/client.js）
```

`tests/fixtures/echo-mcp-server.mjs` 是零依赖的手写 stdio MCP 服务器，用于端到端验证。

### 已验证的端到端路径

在独立 profile（`--profile mcp-test --port 3999`）上实测通过：外部目录列出 9 个组合 MCP 服务器及其全部工具；添加 / 编辑（实例重启）/ 停用 / 启用 / 删除；组合行停用（175→0 工具）/ 移除 / 恢复（13 工具回归）；停用状态跨宿主重启保持；浏览器表单添加与工具计数点击展开。

## 许可

[MIT](LICENSE)

<a id="english"></a>

# dsh-mcp-manage (English)

MCP management plugin for the DSH (DeepSeek Harness) web GUI: a **Settings → MCP 管理** page that lists, adds, edits, deletes, and enables/disables MCP servers — effective immediately, no host restart, no dsh source changes.

## Features

- **List every installed MCP tool**: managed servers show their discovered tools (`mcp__name__*`); servers provided by composition files (`cordis.yml` / `cordis.patch.yml`) appear in a separate read-only catalog.
- **Add**: `stdio` (command / args / env / cwd) and `streamable-http` (URL / headers) transports; saving loads a live instance immediately and its tools register right away.
- **Edit**: restarting the instance under the new config is automatic.
- **Delete / enable / disable**: dispose or reload the live instance in one gesture.
- **Persistence**: records live in `$DSH_HOME/mcp-manage/servers.json` and every enabled server is restored on host start.
- **Loud failures**: bad definitions surface as a failed row with the error text instead of silent background retries.

## Install

```sh
dsh plugin --profile web add link:<path to this repo>
# or, once published:
dsh plugin --profile web add dsh-mcp-manage
```

Restart `dsh web`, then open **Settings → MCP 管理**. Requires DSH ≥ `0.1.0-rc.6` (a web-app composition).

## How it works

The host half serves `/api/dsh-mcp-manage/*` on `ctx.webServer` and loads each enabled record as an `@deepseek-ai/dsh-mcp-client` instance (an effect-scoped child of this plugin's fiber — disposal cascades automatically; the client package resolves from the running dsh installation as an optional peer). The browser half registers the settings page through the `settings.section` slot and talks to the host over plain fetch. Tool enumeration reads `ctx.tools.schemas()` and groups every `mcp__*` name by server namespace.

## Development

```sh
pnpm install
pnpm run typecheck && pnpm test && pnpm run build
```

`tests/fixtures/echo-mcp-server.mjs` is a dependency-free hand-rolled stdio MCP server used for end-to-end verification (add / edit / toggle / delete / browser form / restart restore were all exercised against a dedicated test profile).

## License

[MIT](LICENSE)

