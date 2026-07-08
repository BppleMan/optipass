# Optimize Password

本地 1Password 重复项整理工具。当前实现采用 Angular UI + Node.js TypeScript 后端，后端通过 1Password JavaScript SDK 操作 1Password。

后续重复判定与清理语义以 [docs/duplicate-semantics.md](docs/duplicate-semantics.md) 为准；当前代码如与该文档冲突，说明代码仍待调整。

## 安全边界

- 不支持也不需要 `.1pux` 或 CSV 导出。
- 本地 API 默认只监听 `127.0.0.1`。
- API 和生产模式前端都会返回 CSP、`X-Frame-Options`、`nosniff`、`no-store` 等基础安全响应头。
- 1Password 原始 item 只在后端进程内存中处理，不写入磁盘。
- 可以随时清空当前扫描结果和后端内存中的完整 item 缓存；这个动作不会改动 1Password 数据。
- UI 不展示密码、TOTP secret、API key 等敏感值，只展示摘要和“是否存在”。
- 删除默认建议使用归档，可恢复；永久删除需要显式选择，并在执行时输入 `永久删除` 短语确认。
- 默认禁止真实归档、删除和跨保险库迁移；需要在程序状态栏中手动切换为“可写”后，才允许后端调用真实变更接口。

## 启动

仓库根目录只用 `Justfile` 编排任务，不再是 pnpm workspace。各子项目各自保留 `package.json` 和 `pnpm-lock.yaml`，例如 `apps/api`、`apps/web` 和 `packages/core`。

1. 在 1Password 桌面 App 中开启 SDK 集成：
   - Settings > Developer > Integrate with other apps
   - 如果要使用生物识别授权，也请在 Security 设置里开启 Touch ID / Windows Hello / system authentication
2. 安装各子项目依赖：

```bash
just install
```

3. 启动本地工具：

```bash
just dev-browser
```

真实扫描默认使用 1Password Desktop App 本机交互授权。启动后在 UI 中输入 account name 或 account_uuid；如果不想每次输入，也可以把它设为默认值：

```bash
OP_ACCOUNT_NAME="你的 1Password 账户名或 account_uuid" just dev-browser
```

也可以在 UI 中选择“演示数据”检查交互流程。
默认启动为“只读”，只允许真实扫描和试运行，不会改动 1Password 数据；确认要执行真实变更时，可在状态栏切换为“可写”。

如果要用 service account，可改用：

```bash
OP_SERVICE_ACCOUNT_TOKEN="ops_..." just dev-browser
```

service account 只能访问被授权的 vault；Desktop App 授权适合整理个人账户中的可访问 vault。

默认前端来源只允许 `http://127.0.0.1:4200` 和 `http://localhost:4200`。如果你改了前端端口，可设置：

```bash
WEB_ORIGINS="http://127.0.0.1:4300" OP_ACCOUNT_NAME="..." just dev-browser
```

4. 打开前端默认地址：

```text
http://127.0.0.1:4200
```

生产构建后也可以只启动一个本地服务：

```bash
just serve-local
```

它会构建 `packages/core`、`apps/web` 和 `apps/api`，再由 API 进程服务生产版 Angular UI。启动后会自动打开浏览器；如果未自动打开，请查看终端输出的本地地址。

桌面 App 使用 Tauri 启动。Tauri 拥有 Angular UI，Rust 主进程会优先用随 App 分发的 Bun runtime 启动打包进 App resources 的 API helper；开发期如果内置 runtime 缺失，才回落到系统 Node.js：

```bash
just dev-tauri
```

构建桌面包：

```bash
just build-tauri
```

Tauri 路线不再由 API 服务 UI dist；Angular UI 由 `apps/tauri` 的 `frontendDist`/`devUrl` 加载，后端只作为本地 HTTP helper 运行。`apps/tauri/resources/api` 会被搬到 `.app/Contents/Resources/api`，`apps/tauri/resources/runtime` 会被搬到 `.app/Contents/Resources/runtime`。

开发期需要分别运行 API 或 UI 时，也可以使用：

```bash
just dev-api
just dev-ui
```

确认要执行真实变更时，不需要重启服务或设置环境变量，在页面状态栏把“只读”切换为“可写”即可。

## 当前能力

- 跨保险库扫描所有可访问 item。
- 基于 `@1password/sdk@0.4.x`，默认使用 Desktop App 授权；后端按 vault 批量读取完整 item。
- UI 会显示本地 API 地址、入口模式、授权来源和 Desktop Auth 支持状态，方便真实扫描前排查配置。
- 按标题、URL、用户名+URL、敏感字段哈希、普通字段值等多条件归组。
- 支持 1Password SDK 当前暴露的全部 item 类型，并保留未知类型为 `unknown`。
- 每个重复组给出推荐保留项。
- 推荐保留项会显示非敏感推荐理由，例如 TOTP、附件、备注、字段数量、URL 数量或最近更新。
- 扫描后会显示重复组分布概览，可按高/中/低置信度、跨保险库、TOTP、Passkey、附件快速筛选。
- 重复组列表可按置信度、命中规则、保险库和 item 类型筛选，可按处理优先级、数量、置信度或命中规则数排序，并标注跨保险库、TOTP、Passkey、附件和低置信度组。
- 详情区支持上一组/下一组浏览；跳过或完成一组后会尽量停在相邻位置，方便连续处理长列表。
- UI 可为每个 item 勾选多个保留项，并选择保留项目标保险库。
- 组内支持快捷应用推荐保留、全部保留、未保留全部归档，便于处理较大的重复组。
- 可跳过当前重复组，也可撤销上次跳过；跳过和撤销只会调整当前整理列表，不会改动 1Password 数据。
- 可清空当前扫描；清空只会移除本地扫描结果和后端内存缓存，不会改动 1Password 数据。
- 后端生成执行计划，执行前展示会归档、删除或迁移哪些 item。
- 执行计划会汇总保留、移动、归档、永久删除数量和受影响保险库，便于执行前核对影响面。
- 执行计划会由后端规范化动作顺序：保留、跨保险库迁移、归档、永久删除。
- 真实扫描下必须先成功试运行当前执行计划，试运行会返回后端校验结果，但不会调用归档、删除或迁移动作。
- 状态栏处于“只读”时，即使试运行通过，真实执行也会被后端阻止。
- 状态栏切换为“可写”后，真实执行仍然必须先成功试运行当前执行计划。
- 执行结果会显示成功/失败摘要和逐项结果，失败时保留错误原因用于核对。
- 整组执行成功后会从当前扫描结果中移除该组，并自动进入下一组，适合连续处理较多重复项。
- 如果真实执行中有任何动作失败，后续动作会被跳过，当前扫描会被标记为需要重新扫描，避免扩大部分失败的影响范围。
- 后端返回的校验、授权、并发保护错误会直接显示在 UI 顶部。
- 无保留项的计划会被阻止执行。
- 永久删除需要输入 `永久删除` 短语确认；默认使用归档。
- 演示数据模式下执行计划只做 no-op dry-run，不会调用 1Password。
- 后端会校验执行请求必须覆盖当前重复组的全部 item，防止夹带或漏掉项目。
- 后端同一时间只允许一个真实执行任务，并会阻止执行期间重新扫描，防止多窗口或重复请求并发修改同一扫描结果。
- 生产模式下 API 可直接服务构建后的 Angular 前端，不需要同时运行 Angular dev server。
- Tauri 模式下桌面壳负责加载 Angular UI、用内置 Bun runtime 启动 API helper、注入本地 API 会话；UI 不拥有 shell/spawn 权限。

## 验证

```bash
just test
just typecheck
just build-local
just build-tauri
just smoke-mock
```

`just smoke-mock` 会清空传给临时服务的 `OP_ACCOUNT_NAME` 和 `OP_SERVICE_ACCOUNT_TOKEN`，只验证生产单服务模式、mock 扫描、鉴权、状态栏可写开关和敏感值脱敏，不会连接或修改真实 1Password 数据。

## 迁移说明

1Password SDK 当前没有暴露独立的跨保险库 move API。本工具把跨保险库迁移设计为“在目标 vault 创建副本，成功后归档原 item”的两步计划。复制会包含字段、备注、标签、网站、附件字段和 Document 文件；如果读取或创建失败，源 item 不会被归档。含 Passkey 的 item 会被阻止跨保险库迁移，请保留在原保险库中处理。执行迁移前请先审查计划。
