# Canonical Item Store 与 Backend 契约

## 事实源

一次扫描只选择一个 `ItemProvider`。Backend 读取外部数据并映射为 `CanonicalItem[]` 后，`CanonicalItemStore` 成为当前进程内唯一业务事实源。相似分析、搜索、计划和 Web DTO 均从 Store 派生，不直接读取 1Password SDK 对象或 CSV 行。

Store 只存在于当前进程。重新扫描会原子替换快照；进程退出会清空数据。Store 的每次变更都增加版本，计划必须携带原快照 ID 和版本，避免旧计划覆盖新事实。

扫描响应可以缓存 Store 的脱敏投影用于进度恢复，但该投影不是事实源。Item 搜索、相似分析、计划和执行均直接读取 Store 的当前 Item；Store 变化后不得继续用旧扫描 DTO 完成业务查询。

扫描启动响应中的 ID 标识异步扫描任务；完成事件及 `/api/scan` 快照中的 `scanId` 标识已装载的 Store snapshot。分析与计划必须使用完成快照 ID，不能拿任务 ID 代替 Store snapshot ID。

## Backend 边界

`ItemRepositoryService` 是唯一 Item 增删改入口。它直接读取和修改 Store 中的 Canonical Item，并在同一个仓储操作内部调用 Backend writer 完成外部写回。调用方只观察 Repository 的操作结果，不感知 1Password SDK、CSV 或其它后端细节。

Backend 不保存 Canonical Item 副本，也不提供执行期 Item 查询接口。真实写回所需的当前 Item 由 Repository 从目标 Store 读取后传入 Backend。Backend 可以缓存 SDK 会话、供应商原生写回材料和容器元数据，但这些适配器状态不能作为分析、搜索、计划或前端 DTO 的读取来源。

Backend 提供三类能力：

- 扫描和规范化外部 Item。
- 声明 CRUD 与数据能力，并执行、校验真实变更。
- 把 `ActionDraft` 中的用户意图展开为后端真实步骤，并在 Store fork 上模拟同样的步骤。

Planner 为组内所有真实步骤分配唯一且稳定递增的 `sequence`，并在执行前返回步骤 DTO、blocker、warning、计划统计和 SHA-256 `planHash`。后端按 tab 缓存包含 Action 实例的完整计划；前端启动执行时只提交 `planId + planHash`，不能回传或要求后端重建 Action。这样预览步骤、执行步骤和 SSE `actionId` 始终是同一套实例。前端只按 `actionId` 更新进度。

Core 不包含供应商行为。例如 1Password 的跨保险库迁移由其 Backend 展开为“创建目标副本”和“归档源 Item”两个有依赖关系的步骤；其它 Backend 可以映射为单个原子更新。

执行模式不按 provider 名称硬编码。关闭试写模式时，只有完整计划涉及的 Backend 都声明支持对应真实步骤才允许真写；否则在计划开始前明确阻断。开启试写模式时，统一操作 Store fork，不调用真实 CRUD。

## CSV Backend

CSV Backend 接受 1Password CSV 导出，表头必须为：

```text
Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes
```

解析遵循标准 CSV 引号转义，允许字段包含逗号、双引号和换行。每一行映射为一个 `CanonicalItem`，整个文件映射为一个只读容器：

- `Username` 映射为 username 或 email identity。
- `Url` 映射为规范 URL 输入；URL 相似规则仍由相似分析统一处理。
- `Password` 和 `OTPAuth` 只进入 Store 的秘密字段，永不进入 Web Item DTO。
- CSV 没有 Passkey 列，因此不会推断 Passkey。
- `Archived` 映射为生命周期状态。
- CSV Backend 不支持真实 CRUD；真实执行必须被能力检查阻止。
- dry-run 可以在 Store fork 上模拟更新、归档、删除和迁移，不修改原文件或正式 Store。

Web 端只读取用户主动选择的文件内容并发送给本机 API，不上传到第三方，也不持久化文件内容。

## 执行完成后的分析

Repository 在一次操作内完成后端写回和 Store 变更。只有后端明确确认写回成功，Store 变更才对调用方可见；如果外部结果无法确认，Store 标记为 Stale 并要求重新扫描。dry-run 使用相同 Repository 操作，但目标是 Store fork 且不调用后端写接口。任务终止后对目标 Store 做完整相似分析：仍相似的 Item 继续展示，不再相似的组自然消失，新关系和拆分组也会如实出现。真实执行后的重算结果同步到所有已建立的 tab workspace；旧 draft 失效，只有 group ID 未变化的跳过状态可以保留。前端不得依据旧 group ID 或 `completedGroupIds` 主动删除组。
