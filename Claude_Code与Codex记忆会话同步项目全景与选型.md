# Claude Code 与 Codex 的记忆、会话同步和上下文协作：项目全景与选型指南

> 调研日期：2026-08-25
> 
> 本文整理 GitHub 仓库、项目 README、源码入口、插件 manifest、配置示例、release/commit 和前期对抗性复核结果。评分是类内采用分，不是跨类别的绝对产品质量。安装前仍应在目标机器、目标版本和临时仓库中完成 round-trip 验收。

## 结论先行

GitHub 上已经有不少 Claude Code、Codex 以及其他 AI 编程工具之间的记忆、会话导出、handoff、规则同步和多 agent 编排项目，但它们解决的不是同一个问题。当前没有被独立证据证明同时满足以下全部条件的成熟通用产品：

- Claude Code 与 Codex 双向同步；
- 完整、无损地保留 tool call、tool output、thinking、附件、subagent 和 compaction；
- 实时同步；
- 跨机器同步；
- 导入后能在另一 provider 中原生继续；
- 长期稳定维护。

现实中应把需求拆成五层：

1. **规则与配置层**：同步 `AGENTS.md`、`CLAUDE.md`、Cursor rules、MCP、skills、hooks、permissions。
2. **长期记忆层**：保存项目事实、决策、踩坑、经验和交接摘要。
3. **当前任务 handoff 层**：把一次 Claude 任务交给 Codex，或生成可审计的交接包。
4. **历史查看与归档层**：搜索、导出、脱敏和启动原 provider 的原生 resume。
5. **运行编排层**：并行启动多个 worker、调度、消息、状态门禁和控制面板。

按目标选型的最短答案：

| 目标 | 首选 | 评分 | 关键边界 |
|---|---|---:|---|
| Claude → Codex 当前任务迁移 | [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) | 8.1/10 | 主要是单向迁移，不是实时双向同步 |
| 安全、可审计的 Claude ↔ Codex handoff | [hiShare](https://github.com/harrychih/hiShare) | 7.7/10 | 覆盖窄，版本门控严格 |
| 双端自动长期记忆 | [Mem0 官方插件](https://github.com/mem0ai/mem0) | 7.7/10 | Codex hooks 需要额外安装和启用 |
| 本地、可审计的长期记忆 | [Engram](https://github.com/Gentleman-Programming/engram) | 8.1/10 | 共享结构化记忆，不是 raw transcript resume |
| 规则和 agent 配置同步 | [Rulesync](https://github.com/dyoshikawa/rulesync) | 8.5/10 | 不迁移会话、执行状态或附件 |
| 历史搜索和脱敏归档 | [sx](https://github.com/JacobLinCool/sx) | 7.2/10 | 归一化可能丢失 provider-specific 语义 |
| 多 worker 运行控制面 | [amux](https://github.com/mixpeek/amux) | 6.8/10 | 不是 transcript converter，许可证需审查 |

推荐的分层组合是：

```text
Rulesync                  → 规则、MCP、skills、hooks、权限配置
Engram                    → 本地结构化长期记忆
hiShare / codex-plugin-cc → 明确触发的一次性 Claude↔Codex handoff
sx / AICoder Viewer       → 历史搜索、脱敏归档和审计
amux                     → 并行 worker、调度、消息和验收控制面
```

## 一、先区分四个经常被混淆的概念

### 1. 原生会话迁移

原生会话迁移意味着读取源客户端的持久化 transcript，并在目标客户端的 session store 中创建可继续的 native session。它需要理解 provider 的私有 JSONL、SQLite、thread ID、resume token、tool schema 和版本变化。

这是最难的层。把聊天记录导出成 Markdown、把历史内容放进下一次 prompt，或者在界面上显示两个客户端的记录，都不等于原生会话迁移。

### 2. 任务级 handoff

handoff 通常只传递当前任务所需的摘要、目标、文件范围、约束、已完成工作和待办。它比完整 transcript 安全、简单、可审计，但不会保留完整执行状态。

这往往是最实际的跨 agent 协作方式：让 Claude 生成结构化 handoff packet，再让 Codex 从 packet 开始，而不是直接改写 Codex 的私有数据库。

### 3. 长期结构化记忆

长期记忆保存的是项目事实、技术决策、踩坑、经验、待办和交接摘要。它可以通过 SQLite、FTS5、Markdown、Git vault 或远程 memory service 供多个客户端读取。

长期记忆不是完整会话。它通常不包含另一个客户端恢复执行所需的全部 tool call、tool output、附件、内部状态和 resume token。

### 4. 兼容文件共享不等于客户端同步

有些项目让 OpenCode 与 Claude Code 读写同一套 Claude 风格 Markdown 文件，或让 Claude Code 与 Codex 在显式统一数据目录后共享持久化事件/快照。这类方案可以减少重复配置或共享项目级上下文，但不代表实时同步、统一 auto-memory、跨 provider 原生恢复或双向 session converter。

例如 [opencode-claude-memory](https://github.com/kuitos/opencode-claude-memory) 的代码主要读写 `$CLAUDE_CONFIG_DIR/projects/<project>/memory` 下的 Markdown，并通过 OpenCode plugin API 注入 system prompt；它没有 Codex adapter，也不访问 Claude Code/Codex 的原生 session API。它适合描述为“OpenCode 与 Claude 风格记忆文件兼容”，不应列入 Claude↔Codex 同步方案。

[context-mode](https://github.com/mksglu/context-mode) 确有 Claude Code/Codex 两套适配器和同一 SessionDB/SQLite schema；设置 `CONTEXT_MODE_DATA_DIR` 后，两端可以落到同一持久化事件/快照目录。但其默认目录分开，Codex 平台支持仍是 Partial，Codex hook 的 resume 分支不能证明会从其他 session 自动 claim 快照，因此只能判定为“显式配置后的共享持久化后端”，不能宣称自动双向会话同步。

另一个名称相近的 [opencode-claude-code-memory](https://github.com/kuitos/opencode-claude-code-memory) 也不应列入 Claude↔Codex 候选。源码和 npm 包显示它是 OpenCode 插件，按 `~/.claude/projects/<project>/memory` 的文件约定读写 Claude Code Markdown；没有 Codex/OpenAI 适配器、实时监听/同步协议或共享会话后端。它可以归类为 OpenCode 与 Claude Code 记忆文件的共享持久化约定，不能称为实时同步、会话同步或跨 provider 导入导出。

### 补充案例：memtrace——共享图和决策记忆，非聊天同步

项目：[syncable-dev/memtrace-public](https://github.com/syncable-dev/memtrace-public)

`memtrace` 的 Claude Code 和 Codex 配置可以指向同一 `memtrace mcp`。stdio 子进程可附着同一 workspace owner 和 `.memdb`，streamable-HTTP 也可由多个 session 复用；官方文档还说明多个 repository 可以共享一个 `.memdb` 图。仓库中的 ContextBench Codex runner 会实际生成 `config.toml` 并运行 `codex exec --json`，因此这不是只有 README 的配置声明。

但它共享的是代码图、episodes 和 Cortex 决策记忆，通过 MCP 工具查询；`session-continuity`/`continuous-memory` 是 anchor、增量索引和 watcher 驱动的 agent workflow。没有证据表明它会自动捕获或合并 Claude/Codex 的完整聊天全文、导入导出双方 session，或让一个 provider 的 session 在另一个 provider 中 native resume。源码 watcher 的“实时”只描述文件变化，不是聊天同步。

**判定：部分确认/范围受限。** 它可作为共享持久化代码与结构化决策记忆后端，但不能列入自动 Claude↔Codex 聊天记忆同步器。公开 issue 还记录了 Windows watcher 长时间没有 episode、MCP SIGTERM 无法停止、WAL snapshot 可能导致超大内存分配，以及当前缺少持久 Claude routing directive 等落地风险；采用前应做目标平台端到端测试。

### 补充案例：Memorix——共享项目记忆，非聊天镜像

项目：[AVIDS2/memorix](https://github.com/AVIDS2/memorix)

Memorix 的 Claude 和 Codex 插件都启动 `memorix serve --mode lite`，两端可以打开同一个共享 SQLite 后端，并按归一化 Git project identity 过滤项目数据；默认数据目录是全局 `~/.memorix/data/`，并不等于把数据库物理存进 Git 项目目录，也可以用 `MEMORIX_DATA_DIR` 覆盖。只要两端绑定到同一 project identity 和 data directory，两个客户端就能搜索共享的持久化记忆；绑定错误、无 Git remote 或缺少明确 `projectRoot` 时可能串库或漏读。它还提供 HTTP control plane，允许多个客户端复用同一服务进程。

但官方 API 文档明确限定：shared memory 只是同一项目中可跨客户端搜索的已保存 memory，不是逐条镜像聊天消息。写入会递增数据库 generation，其他进程在读取时刷新索引；这不是 event bus 的跨进程实时推送，stdio 也不是自动的统一服务进程。session/handoff/context 是结构化注入，不是完整聊天恢复，导入导出是额外迁移路径而非正常同步机制。

### 补充案例：memsearch——共享 Markdown 摘要记忆，配置不一致时会分叉

项目：[zilliztech/memsearch](https://github.com/zilliztech/memsearch)

memsearch 为 Claude Code 和 Codex 提供插件与 hooks：Stop hook 分别解析 Claude transcript 和 Codex rollout，将摘要追加到项目 `.memsearch/memory` 的 Markdown 日志，再调用 `memsearch index`；SessionStart 注入最近日志，`memory-recall` skill 可按需 search/expand。Markdown 是 source of truth，Milvus 只是可重建的 shadow index；默认使用 Milvus Lite，远程 Milvus/Server 模式才有按文件变化的 watcher 重索引。因此它共享的是摘要记忆和检索索引，不是活动会话、完整上下文或 native session。

两端只有在 hooks 解析到同一 Git root、使用同一 `.memsearch` 配置和 collection，并且远程索引服务配置一致时，才可能交叉检索同一项目日志。非 Git 目录、`CLAUDE_PROJECT_DIR` 与 hook cwd 不一致、目录移动或默认 Lite 配置，都可能形成不同目录或 collection。公开 issue [#631](https://github.com/zilliztech/memsearch/issues/631) 记录了“two stores, two collections, no shared memory”的实际失败模式。

**判定：条件成立的共享持久化后端 + 共享 Markdown 约定，非实时聊天同步器。** v0.4.19 已发布且项目仍维护，但 PyPI/release 只证明发行状态，不证明跨客户端语义完整；采用前应验证同一 Git root、绝对路径哈希、collection、Milvus 模式、目录移动和双向 nonce round-trip。

### 补充案例：claude-memory-mcp——共享历史证据索引，非双向 memory sync

项目：[WhenMoon-afk/claude-memory-mcp](https://github.com/WhenMoon-afk/claude-memory-mcp)

该项目为 Pi、OpenMemory/OMP、Claude Code project JSONL、Codex rollout JSONL 和 ChatGPT export 提供 adapter，把本地授权历史读入同一个可重建的 SQLite/FTS5 evidence projection；Claude Code 与 Codex 可分别注册同一个本地 stdio MCP，并通过 `moon cite_recall`、`moon cite_inspect` 和 `moon cite_status` 进行引用式历史召回。源码和协议文档明确：source files never written，默认只有 recall/inspect/status；learned-memory 四工具需要显式开启，并写入独立的 learned-memory SQLite，内容是 agent-authored interpretation，不会修改原始历史或 evidence index。

它的 recall 先查现有索引，miss 时才做有界增量刷新；status refresh 也不是跨进程 event bus 或实时 push。因此它成立的是“多个客户端共享同一份本地历史派生索引和只读检索”，不是双向长期记忆同步、提示词兼容层、活动 transcript 镜像或 native session converter。项目仍在维护（v4.0.5 于 2026-08-19 发布），但采用前应确认各 adapter 的授权范围、同一 MCP 数据目录、增量刷新延迟和 learned-memory 是否需要显式启用。



viewer 可以读取多个客户端的本地 session、建立索引、搜索、统计、导出，甚至调用原 provider 的 resume 命令。但它通常不会把 Claude session 写成 Codex native session。

因此应分别验收：

- 能否找到旧对话；
- 能否导出原始数据；
- 能否在源 provider 中 resume；
- 能否转换为目标 provider 可继续的 native session。

这四个能力不是一回事。

## 二、历史会话迁移与 Claude ↔ Codex handoff

### 2.1 `openai/codex-plugin-cc`：Claude → Codex 的首选路径

项目：[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)

它提供 Claude Code 侧的 `/codex:transfer`，读取 Claude Code 的 JSONL 会话，通过 Codex external-agent session importer 创建持久 Codex thread，使任务可以在 Codex App/TUI 中继续。

**评分：8.1/10。**

优势：

- 目标功能与 Claude → Codex 迁移高度匹配；
- 有明确的 slash command、源 JSONL 读取和 Codex importer 实现入口；
- 相比直接修改 Codex 私有 SQLite，更接近目标客户端的正式导入路径；
- 维护和采用信号明显强于多数个人转换脚本。

边界：

- 主要证据是 Claude → Codex，不应宣传成 Codex → Claude 双向方案；
- 未证明附件、复杂 tool-call、subagent、compaction、错误重试等场景全部无损；
- 不是实时同步；
- OpenAI 组织下的仓库不等于 Anthropic 与 OpenAI 已共同制定跨客户端同步标准。

**建议**：作为受控试用的首选。迁移前备份 `~/.claude/projects` 和 `~/.codex`，先在 disposable repository 上验证目标版本的 `/resume`、工具调用和工作树状态。

### 2.2 hiShare：安全优先的窄桥

项目：[harrychih/hiShare](https://github.com/harrychih/hiShare)

hiShare 的重点不是覆盖尽可能多的客户端，而是限制写入风险并让 handoff 可检查。它支持生成 `handoff.json`、`handoff.md` 和 `handoff.redaction.json`，提供交接 brief、审计 packet、脱敏规则与计数，并支持 JSON Schema、digest/semantic/secret scan。

**评分：7.7/10。**

关键安全边界：

- 读取源 agent store 时保持只读；
- 默认 dry-run；
- 写入 native session 前进行版本门控；
- 无法安全对应的工具会降级为摘要，而不是假装保持完整语义；
- 当前精确测试版本为 Claude Code 2.1.220 和 Codex 0.146.0，未测试版本可能在写入前被拒绝。

版本门控是优点也是成本：它避免未知格式被静默写坏，但客户端升级后需要等待适配或重新验证。

**建议**：安全、审计和可回滚优先时，hiShare 比“直接改 JSONL/SQLite”的转换器更适合。它不是实时双向同步器，MCP servers、skills 和 plugins 也主要以描述性 metadata 形式参与，不会携带凭证或可执行定义。

### 2.3 `claude-codex-switch`：双向但不能称无损

项目：[gitgoready/claude-codex-switch](https://github.com/gitgoready/claude-codex-switch)

它明确实现 Claude → Codex 和 Codex → Claude 的 JSONL 转换，并读写 Codex `state_5.sqlite`。

**评分：5.4/10。**

主要问题：

- 强依赖两个客户端的私有 JSONL/SQLite schema；
- 已知 tool input 约 4k、output 约 12k、thinking 约 500 字符存在截断；
- 版本升级可能改变内部格式；
- 写入目标 session store 的失败影响比普通 Markdown 导出更大。

**建议**：只在副本上进行双向实验。不能把“实现了双向转换”写成“提供无损双向同步”。

### 2.4 UniSessions：覆盖广，但成熟度不足

项目：[vibheksoni/session-export](https://github.com/vibheksoni/session-export)

UniSessions 的 README 列出 Claude Code、Codex、Pi、OpenCode、Devin/Windsurf CLI、Factory、Windsurf Cascade 和 Grok Build，并宣称 56 个转换方向。它还提供 SDK/CLI/MCP、SQLite FTS5 搜索，以及 `dry-run`、`--write`、`skip`、`overwrite`、`fork`、`update` 等转换控制。

**评分：5.4/10。**

独立源码和 PyPI 0.2.0 wheel 交叉核验后，可以确认它的真实能力是显式 `claude-to-codex` / `codex-to-claude` 导入导出，以及基于本地 SQLite FTS5 的跨 provider 历史检索。MCP server 只提供 list、index status、refresh 和 search；转换器分别写入目标 provider 的目录，不建立共享持久化后端，也没有 watcher、event bus 或实时合并路径。

官方 data-fidelity 说明将其限定为 text-history conversion：tool calls、approval、sandbox、MCP runtime 等运行时语义不会保留。因此，“README 中列出 56 个方向”不等于每个方向都经过目标 vendor 版本化 native-resume 回归；当前虽有近期维护信号，但项目仍处于新/Beta 阶段，导入后的可继续执行能力不能按完整恢复计算。

**建议**：适合个人归档、实验室和批量格式探索；重要项目必须先复制源 store，完整 dry-run，抽样检查工具调用、附件、compaction 和 cwd，再考虑 `--write`。它应归类为显式历史转换器和检索器，不是实时同步器。

### 2.5 其他 handoff/bridge 项目应如何定位

以下项目可以帮助 Claude 和 Codex 传递任务或结果，但不能当作完整历史会话迁移器：

- [claude-codex-mcp-bridge](https://github.com/WebisityStudio/claude-codex-mcp-bridge)：本地 stdio MCP、SQLite WAL mailbox、send/wait/ack/thread，可启动并继续 Codex worker；传的是任务和结果，不会重建 Claude 历史 JSONL。
- [claude-codex-mcp](https://github.com/maferick/claude-codex-mcp)：提供 consult、`post_handoff`、`get_context`、`record_decision`，主要写项目协作日志。
- [plugin-handoff](https://github.com/ulpi-io/marketplace)：共享 handoff skill，传递 bounded task/context，不读取完整源 transcript。
- [cc-plugin-codex](https://github.com/sendbird/cc-plugin-codex)：Codex 侧启动和跟踪 Claude subprocess，可 resume 最近 Claude task，属于宿主编排，不是 transcript converter。
- [claude-codex-handoff](https://github.com/Fundryi/claude-codex-handoff)：`codex-plugin-cc` 的增强/可靠性 fork，默认权限可能使用 `danger-full-access`，必须先审查并收紧为最小权限。
- [claude-session-port](https://github.com/TomSOhm/claude-session-port)：只打包和导回 Claude Code 自己的 JSONL/sidecar，以便跨机器尝试 `/resume`；没有 Codex adapter、共享后端或跨 provider 协议转换，不能列为 Claude↔Codex 同步方案。

## 三、双端自动长期记忆

### 3.1 Mem0 官方插件：证据和维护最强的双端候选

项目：[mem0ai/mem0](https://github.com/mem0ai/mem0)

Mem0 官方插件同时覆盖 Claude Code 和 Codex，但必须区分 MCP-only 与完整 plugin：

- Claude Code marketplace 安装可提供 MCP、生命周期 hooks 和 SDK skill；
- Codex 可以直接接远程 MCP，也可以 sideload 官方 plugin；
- Codex 自动生命周期记忆需要额外运行 `scripts/install_codex_hooks.py`，并在 `~/.codex/config.toml` 设置 `codex_hooks = true`；
- 只看到 `add_memory` 或 `search_memory` 工具，并不表示每轮会话已经被自动捕获；
- Codex Cloud 的 ephemeral 环境不适合依赖本地 hooks，应区分 Direct MCP 路径。

**评分：7.7/10。**

它的官方文档、维护信号和双端实现证据较强，但部署步骤比“安装一个 MCP server”复杂。旧的 [mem0-mcp](https://github.com/mem0ai/mem0-mcp) 已归档，不应作为当前安装入口。

### 3.2 Supermemory：两个 adapter 写入共享 container

项目：[Supermemory](https://github.com/supermemoryai/supermemory)、[Claude adapter](https://github.com/supermemoryai/claude-supermemory)、[Codex adapter](https://github.com/supermemoryai/codex-supermemory)

Claude 侧通过 marketplace 安装插件；Codex 侧通过 `npx codex-supermemory install` 注册配置、hooks 和 skills。Codex adapter 使用：

- `UserPromptSubmit`：搜索并注入相关记忆；
- `Stop`：flush 最后的 session 内容；
- `/supermemory-search` 和 `/supermemory-save`：作为显式 fallback。

两端通过 normalized Git remote 共享 project/user container，理论上可让不同 clone 使用同一项目记忆。

**评分：7.0/10。**

它的双 hooks 体验直接，但安全分低于本地方案：自动 hook 可能在没有逐次人工提示的情况下读取并上传纳入范围的会话内容。上线前必须核验：

- container tag 是否一致；
- `SUPERMEMORY_ISOLATE_WORKTREES` 等隔离策略；
- 数据保留、删除和训练政策；
- project/user namespace；
- 商业许可和数据处理条款。

### 3.3 PAXM：同一 SQLite 后端加生命周期 hooks

项目：[pax-beehive/paxm](https://github.com/pax-beehive/paxm)

PAXM 为 Claude Code 和 Codex 提供独立插件与 hooks，两端通过同一 config/runtime/router 使用同一个 SQLite memory backend。Claude 的 hook 调用 `paxm __hook --target claude`，Codex 侧调用对应的 `--target codex`；两端都覆盖 session start、user input 和 turn end，可做 passive recall、写入和长期记忆保存。Codex 的 `UserPromptSubmit` 输出也符合官方 `additionalContext` hook envelope。项目 acceptance 文档记录了真实 Codex 任务中修复 hook JSON 后成功召回上下文，但这仍主要是仓库自测，不等同于独立端到端复现。

**判定：共享持久化后端 + 生命周期 hook 的双端长期记忆，范围受限。** 两端必须安装插件、运行 setup，并使用同一 config/data path；默认 SQLite 路径是 `~/.local/share/paxm/memory.sqlite`，自定义 config 可能改变数据位置。它捕获的是 hooks 可见的事件和文本，不复制完整上下文、工具内部状态或实时 transcript，因此不是会话镜像、实时同步或 native session converter。维护状态仍在持续但活跃度一般（v0.2.6 于 2026-07-26 发布，之后有提交）；采用前应锁定版本并验证 hooks、同库隔离和召回质量。

### 3.5 Claude-Mem：Claude 体验强，Codex 路径较新

项目：[thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)

Claude-Mem 通过 lifecycle hooks 捕获工具使用，生成语义摘要，再通过 MCP search tools 做渐进式召回。仓库同时存在 `.codex-plugin/plugin.json`、`plugin/hooks/codex-hooks.json` 和 MCP 配置，说明 Codex 路径不是空口兼容。

**评分：7.0/10。**

但主安装和排障文档仍以 Claude Code 为中心，Codex 的版本兼容、并发写入和召回质量需要单独验证。它和 Mem0、Supermemory 一样，主要保存摘要、索引和结构化记忆，不是 raw transcript/native resume。

## 四、本地或自托管长期记忆

### 4.1 最终评分

| 排名 | 项目 | 总分 | 适合场景 |
|---:|---|---:|---|
| 1 | [Engram](https://github.com/Gentleman-Programming/engram) | **8.1** | 本地结构化项目记忆 |
| 2 | [openwolf](https://github.com/cytostack/openwolf) | **7.5** | 随 Git 传播的项目 brain |
| 3 | [Agent Memory Vault](https://github.com/mcncarl/agent-memory-vault) | **7.2** | claims、closeout、audit 团队审计 |
| 4 | [mnemonic](https://github.com/danielmarbach/mnemonic) | **7.1** | 低成本 Markdown/Git vault |
| 5 | [memex](https://github.com/iamtouchskyer/memex) | **7.0** | cards 和项目知识 |
| 6 | [mem-zero](https://github.com/sworcery/mem-zero) | **7.0** | 能运维自托管服务的团队 |
| 7 | [MemoryGraph](https://github.com/memory-graph/memory-graph) | **6.9** | 关系型项目记忆 |
| 8 | [Cloudflare MCP Memory](https://github.com/beach55607-max/mcp-memory-server) | **6.1** | Cloudflare backend、交互式 Codex PoC |

### 4.2 Engram：本地记忆层首选

Engram 是 Go 单二进制，使用 SQLite + FTS5，并提供 CLI、HTTP API、TUI 和 MCP。README 明列 Claude Code、Codex、OpenCode、Gemini CLI、VS Code/Copilot、Cursor、Kiro 等 setup。

它提供 `mem_save`、`mem_search`、`mem_context`、`mem_timeline`、`mem_session_start/end/summary` 等工具，定位是让 agent 保存和召回结构化项目知识，而不是把所有历史 transcript 原样塞回上下文。

**评分：8.1/10。**

优势：

- 同一机器、同一用户和同一 `ENGRAM_DATA_DIR` 下，Claude Code 与 Codex 的插件可连接同一个 SQLite 持久记忆后端；默认数据目录是 `~/.engram`；
- FTS5 适合长期项目知识检索；
- 有 Git-friendly sync，可把审查后的 `.engram/` chunks 带到另一台机器；
- 可选 cloud autosync/continuous replication，但需要显式开通、token 和服务配置；
- 客户端覆盖广，部署形态相对简单。

边界：

- 共享的是 observations、prompts 和结构化记忆，不是同一个 live session；两端各自创建 session，结束 hook 不会合并会话或广播完整 transcript；
- 记忆质量依赖 agent 是否显式调用 `mem_save` 或 session summary；
- Git sync 是导出/导入，默认启动 hook 的导入也不是实时双向同步，未看到 session-stop 自动 export；
- stdio MCP 是主要 transport，不应假设存在可直接从 Docker 访问的 TCP MCP endpoint；
- `engram serve` 默认只绑定 loopback；容器需要正确挂载 binary 和数据卷；
- `.engram/` Git sync 前必须审查 API key、token 和私人 transcript；
- 它不是 Claude/Codex native session converter；不同 Codex host/version 仍需单独验证 hooks。

### 4.3 TrueMemory：双端 hooks 写入同一持久记忆库，非实时会话同步

项目：TrueMemory（仓库链接待补充）

TrueMemory 为 Claude Code 和 Codex 注册同一个本地 MCP，并分别安装 SessionStart、UserPromptSubmit、SessionEnd/Stop 和 PreCompact hooks；默认数据库是 `~/.truememory/memories.db`，hooks 可以通过 `--db` 或环境变量覆盖。SessionStart 从数据库搜索并注入 `additionalContext`，Stop/SessionEnd 读取 transcript 后异步 ingest，因此在同一用户和同一 DB 路径下，双端共享真实持久化记忆后端，而不是只有 `CLAUDE.md`/`AGENTS.md` 提示词约定。

**判定：共享持久化后端成立；实时会话同步不成立。** 两端仍是独立 session，记忆写入是异步的，不能镜像当前上下文、工具状态或 native resume；自定义 DB path/user_id 也可能造成分库。Codex adapter 的配置和 hook schema 仍需按目标版本验证，仓库测试主要验证 TOML/MCP/hook 配置，缺少 Claude↔Codex 端到端回归。当前文档还存在旧 flat `[[hooks]]` 示例，而源码已迁移到 nested hook schema；应优先使用 setup/doctor/smoke test，不要照旧手工配置。

### 4.4 Git vault 和项目 brain

- **openwolf（7.5）**：使用 `.wolf` brain 保存修正、bug、项目图等，适合随 Git 传播。AGPL-3.0 可能阻断闭源产品或服务化嵌入。
- **Agent Memory Vault（7.2）**：Git-backed Markdown source of truth，配合 SQLite/FTS、session claims、closeout 和 audit；在同一或已共享的文件系统、且两端按流程主动 retrieve/search 和 closeout 的前提下，适合团队审计和长期记忆。Claude 原生 auto-memory 仍独立，Git 主要提供本地历史/回滚，不是内建的跨机同步服务；项目较新，并发写入和脱敏证据仍弱于 Engram。
- **mnemonic（7.1）**：Markdown/JSON + Git vault，适合事实、决策和踩坑；部署成本低，但 skill 层与各客户端不完全对称。
- **memex（7.0）**：共享 `~/.memex/cards`，支持 Git sync，并提供 Claude plugin、Codex MCP 等入口；适合 cards/知识，不是完整会话恢复。
- **mem-zero（7.0）**：自托管 streamable-HTTP MCP，同时提供 Claude 和 Codex 配置；自动保存依赖 `AGENTS.md`/`CLAUDE.md` 指示，agent 不遵守规则就不会自动写入。
- **MemoryGraph（6.9）**：本地 CLI graph memory，通过 `CLAUDE.md` 或 `AGENTS.md` 规定调用协议；两端可共享数据库，但没有原生 Codex plugin 或 MCP 自动注入。
- **Cloudflare MCP Memory（6.1）**：README 明确给出 Claude Code 和 Codex 配置，但记录了 `codex exec --full-auto` 下 MCP tool call 可能因 approval 限制被取消；交互式和非交互式模式必须分别测试。

## 五、规则、MCP、skills 和 hooks 同步

### 5.1 Rulesync：规则/agent 配置层首选

项目：[dyoshikawa/rulesync](https://github.com/dyoshikawa/rulesync)

Rulesync 以 `.rulesync/` 作为规范源，通过 `generate` 生成多个客户端配置，也支持 `import`、`convert`、`check`。其范围不止规则文本，还包括 MCP、commands、subagents、skills、hooks、permissions 和 ignore/checks，并覆盖 Claude Code、Codex CLI、Cursor、Copilot、Cline、Goose、OpenCode、Kiro、Gemini/Antigravity 等目标。

**评分：8.5/10，类别内首选。**

但支持矩阵不等于语义无损：

- Cursor `.mdc` 的 `description`、`globs`、`alwaysApply` 有目标特性；
- Claude `@import` 和 path-specific rules 不一定能等价转译；
- 权限、hooks 和 skills 的生命周期在不同工具中不同；
- 生成结果应该锁版本并在 CI 中检查 diff；
- 生成文件不应被开发者随意手改。

Rulesync **不会**迁移 transcript、工具执行状态、附件或 resume token。

### 5.2 ai-rules-sync：更小的 Markdown 规则方案

项目：[PanisHandsome/ai-rules-sync](https://github.com/PanisHandsome/ai-rules-sync)

**评分：7.0/10。**

它支持 `AGENTS.md`、`CLAUDE.md`、`.cursorrules`、Copilot、Windsurf、Cline、Aider、Gemini 和 Qwen 等规则文件，并提供 `sync --watch`、`sync --check`、`merge`、`convert`、`lint`。适合只需要 Markdown 规则同步的仓库；不应替代 Rulesync 的 MCP、skills、hooks、subagents 和 permissions 配置能力。

### 5.3 `AGENTS.md` 不是完整跨工具标准

`AGENTS.md` 是事实上的共享入口，但不是包含路径 glob、优先级、skills、hooks、MCP、权限和命令语义的完整标准：

- Codex 和 Cursor 可以读取 `AGENTS.md`；
- Claude Code 默认读取 `CLAUDE.md`，可以用 `@AGENTS.md` 或 symlink 复用；
- Cursor `.cursor/rules/*.mdc` 还需要 frontmatter；
- 各工具对路径发现、优先级和生命周期的解释不同。

小项目可以采用一个共享 `AGENTS.md` 加极薄的 `CLAUDE.md` 适配层；复杂项目应使用生成器，并把 tool-specific overlay 单独维护。

## 六、查看、归档和多 agent 编排

### 6.1 sx：安全归档和备份

项目：[JacobLinCool/sx](https://github.com/JacobLinCool/sx)

**评分：7.2/10。**

sx 偏向发现多个 agent 的历史、规范化、脱敏，以及 JSONL/HTML/Markdown/原始文件导出。它比直接修改 vendor store 稳妥，但归一化仍可能丢失 provider-specific tool 和附件语义。

### 6.2 AICoder Session Viewer：多工具只读查看器

项目：[seastart/aicoder-session-viewer](https://github.com/seastart/aicoder-session-viewer)

**评分：6.5/10。**

它可以统一浏览 Claude Code、Codex、Gemini CLI、Antigravity CLI 和 OpenCode，提供搜索、统计、导出，以及调用各 provider 原生 CLI 的 resume 启动器。

它不是跨 provider session bridge。GitHub 元数据中未声明 license，团队或商业采用前必须确认许可证。

### 6.3 session-exporter：只读历史汇总和离线导出

项目：[p2o51/session-exporter](https://github.com/p2o51/session-exporter)

它可以只读解析 Claude Code 与 Codex 各自的本地 JSONL，并导出 ZIP、Notion、JSON 或 Markdown。服务端提供查询和 export 接口，缓存也以只读解析为主；没有 import、resume、sync 或 memory 写回路径。

**判定：历史查看/归档工具，非共享记忆、实时同步或跨 provider 续接适配器。** 适合集中搜索和离线备份，不应因为同时读取两端目录就列入同步方案。

### 6.4 amux：运行控制面而不是记忆权威源

项目：[mixpeek/amux](https://github.com/mixpeek/amux)

**评分：6.8/10。**

amux 管理并行 Claude/Codex/Gemini worker、tmux、SQLite event journal、scheduler、board/status gates、worker messages、scope memory/env 和 dashboard。它适合同时运营多个 agent lane，但不会把一个 provider 的 transcript 转换成另一个 provider 的 native session，也不应被当作长期记忆的唯一事实来源。

注意：许可证是 MIT + Commons Clause，不能简单称纯 MIT；dashboard/API 和 `server.env` 需要按本地安全边界部署，不能直接暴露公网。

## 七、明确排除的常见误判

1. **MCP 可接 ≠ 自动记忆。** 只有 hooks、adapter 或明确生命周期机制，才能宣称自动捕获。
2. **MCP 工具可见 ≠ 记忆链路成功。** 还要证明写入、namespace、container 和下一次会话召回都正常。
3. **统一查看 ≠ 跨 provider resume。** viewer 的 resume 通常只是调用源 provider 的 CLI。
4. **长期记忆 ≠ 原生会话迁移。** Engram、Mem0、Supermemory 和 Claude-Mem 保存的是结构化记忆、摘要或索引，不是另一客户端可继续的完整执行状态。
5. **高 star ≠ 目标匹配。** 规则同步、viewer 和编排工具不能因为采用度高就进入会话迁移榜。
6. **“支持 Codex”需要实现证据。** Codex TOML、plugin manifest、hooks、测试或明确配置比“支持任何 MCP client”的一句话更有证明力。
7. **兼容文件共享不等于客户端同步。** 共享 Markdown、SQLite 或事件目录只能证明存在共同持久化介质；仍需分别验证 namespace、hooks、resume、并发写入和跨 provider 语义。
8. **共享结构化后端不等于共享聊天记忆。** `memtrace` 和 Memorix 可以让 Claude/Codex 查询同一代码图、episodes、决策或项目记忆，但没有聊天全文自动合并或 native session resume 证据。
9. **双端适配器不等于共享安全。** 云端 container、worktree、用户 namespace、保留策略和删除策略都要单独核验。
10. **安全评分不等于绝对安全。** 本地 Git vault 也可能把 token、私钥和私人 transcript 写入历史；自动 hooks 也可能扩大上传范围。
11. **导出成功不等于恢复成功。** 必须单独测试 `/resume`、工具调用、附件、compaction 和工作树状态。
12. **PAXM 的共享 SQLite 不等于实时 transcript 同步。** 它依靠两端各自注册的 lifecycle hooks 和 MCP 读写共享结构化记忆；同一 config/data path 只解决后端一致性，不能证明完整上下文、工具内部状态或 native session 可以跨端恢复。
13. **UniSessions 的 FTS5 检索和双向转换不等于实时同步。** 它从各 provider 的原生文件显式读取、转换并写入目标目录；MCP 只负责索引/搜索，data-fidelity 也明确不保留 tool calls、approval、sandbox 和 MCP runtime。
14. **memsearch 的共享 Markdown 依赖项目身份和索引配置一致。** 同一仓库、同一绝对路径哈希、同一 collection 和 Milvus 模式未确认前，Claude 与 Codex 可能各写各的 `.memsearch` 目录或 collection；即使索引实时重建，也只是摘要文件变化，不是活动 transcript 同步。
15. **派生历史索引不等于双向记忆同步。** `claude-memory-mcp` 将各客户端的授权历史读入可重建 SQLite/FTS5 projection，默认 MCP 工具只读召回；增量刷新和 learned-memory 都不代表修改源 transcript、实时推送或 native session 恢复。
16. **Engram/TrueMemory 的持久化后端不等于 live session。** Engram 的同机共享、Git 导入/导出和可选云端复制，以及 TrueMemory 的 Stop/SessionEnd 异步 ingest，都只提供后续会话可召回的结构化记忆；两端仍各自维护 session，不能宣称完整上下文实时镜像或跨 provider resume。

## 八、最终评分矩阵

### 会话迁移与 handoff

| 排名 | 项目 | 总分 | 采用建议 |
|---:|---|---:|---|
| 1 | `openai/codex-plugin-cc` | **8.1** | Claude → Codex 受控试用 |
| 2 | `hiShare` | **7.7** | 版本受控、安全优先 |
| 3 | `claude-codex-switch` | **5.4** | 仅副本实验 |
| 4 | `UniSessions` | **5.4** | 文本历史转换/检索 PoC；不保证 native resume |

### 双端自动长期记忆

| 项目 | 总分 | 采用建议 |
|---|---:|---|
| `Mem0 官方插件` | **7.7** | 官方双端方案首选候选；先装 Codex hooks |
| `Supermemory 双 adapter` | **7.0** | 云端 PoC/条件生产；先做隐私和 namespace 审查 |
| `Claude-Mem` | **7.0** | Claude 强；Codex 条件试用 |
| `PAXM` | — | 共享 SQLite + lifecycle hooks；尚未纳入本轮评分 |
| `TrueMemory` | — | 共享 SQLite + 双端 hooks；需锁定 Codex hook schema 和版本 |

### 本地/自托管长期记忆

| 排名 | 项目 | 总分 |
|---:|---|---:|
| 1 | `Engram` | **8.1** |
| 2 | `openwolf` | **7.5** |
| 3 | `Agent Memory Vault` | **7.2** |
| 4 | `mnemonic` | **7.1** |
| 5 | `memex` / `mem-zero` | **7.0** |
| 6 | `MemoryGraph` | **6.9** |
| 7 | `Cloudflare MCP Memory` | **6.1** |

### 规则同步与运营控制面

| 类别 | 首选 | 评分 |
|---|---|---:|
| 规则/agent 配置 | `Rulesync` | **8.5** |
| 轻量 Markdown 规则 | `ai-rules-sync` | **7.0** |
| 历史归档 | `sx` | **7.2** |
| 多工具查看 | `AICoder Session Viewer` | **6.5** |
| 只读历史汇总/离线导出 | `session-exporter` | — |
| 并行运营控制面 | `amux` | **6.8** |

分数是**类内采用分**，不能跨类别直接比较。例如 Rulesync 的 8.5 不代表它比会话迁移工具更能恢复 transcript，它根本不处理 transcript。

## 九、推荐落地方案

### 场景 A：把当前 Claude 任务交给 Codex

1. 普通受控迁移：先试 `codex-plugin-cc`。
2. 需要脱敏、审计和版本门控：选 hiShare。
3. 必须双向转换且能接受实验风险：再评估 `claude-codex-switch`，只操作副本。
4. 不要把 viewer、MCP mailbox 或 Markdown handoff 描述成完整 native session migration。

### 场景 B：Claude、Codex、Cursor 共享项目记忆

1. 本地优先：Engram。
2. 云端自动 recall/capture：Mem0 或 Supermemory，先做数据处理审查和 nonce round-trip。
3. Git 文档型：mnemonic、memex 或 Agent Memory Vault；Vault 需先确认共享文件系统/同步机制和两端的 retrieve/search、closeout 流程，不提供自动原生会话同步。
4. 将记忆拆成项目事实、决策、踩坑、待办和交接摘要，不要把全部 raw transcript 直接当长期记忆。

### 场景 C：团队统一 agent 配置

1. 用 Rulesync 维护规范源和 CI 检查。
2. 只需要 Markdown 规则时使用 ai-rules-sync。
3. 将 Cursor globs、Claude path rules、Kiro/工具特有 hooks 等放在 target-specific overlay，不要强行塞入公共 `AGENTS.md`。

### 场景 D：多 agent 并行运营

- 用 amux 管理 worker、board、scheduler、messages 和 scope；
- 用 Rulesync 管理每个 worker 的规则和配置；
- 用 Engram 管理结构化长期记忆；
- 用 AICoder Viewer 或 Recensa 审计原始 transcript；
- 保留 vendor 原始 session 和 Git 规则，不让 dashboard 数据库成为唯一事实来源。

## 十、采用前的最小验收清单

### 长期记忆 round-trip

1. 创建临时仓库和唯一 nonce。
2. 让 Claude Code 写入包含 nonce 的记忆。
3. 完全退出 Claude Code。
4. 用全新的 Codex 会话搜索 nonce。
5. 反向再测一次，确认 Codex 写入后 Claude 能召回。
6. 检查两端使用的是同一个 project/user namespace、container 和 worktree 隔离策略。
7. 对 PAXM 等共享 SQLite 方案，额外确认两端插件都已注册 session start、user input、turn end hooks，实际使用同一 config/data path，并验证并发写入、读时刷新和错误重试。
8. 对 memsearch 等共享 Markdown/索引方案，确认 Claude 与 Codex 解析到同一 Git root，collection 和绝对路径哈希一致；分别测试默认 Milvus Lite、远程 Milvus、目录移动、非 Git 目录和 watcher 延迟，排除双目录/双 collection。
9. 对 `claude-memory-mcp` 等历史派生索引，确认各 adapter 的授权范围、共享 MCP 数据目录、源文件只读约束、miss 后增量刷新延迟，以及 learned-memory 是否显式开启；分别验证 Claude/Codex 的 citation recall，不将索引命中当作 native resume。
10. 对 Engram/TrueMemory 等共享 SQLite 方案，分别验证默认与自定义 DB/data path、Claude/Codex MCP 和 hooks 是否真实注册；测试 Stop/SessionEnd 后异步 ingest 的可见延迟、重复写入、Codex nested hook schema、不同 host/version，以及两端各自 session 不会被误认为合并。

### 会话迁移 fixture

至少覆盖：

- 普通文本；
- 长 tool output；
- MCP 调用及 tool result；
- compaction 链；
- subagent；
- 图片和其他附件；
- 错误重试；
- 不同 cwd 和 worktree；
- 迁移后目标 provider 的 `/resume`；
- 迁移后继续执行一个真实工具调用。

### 写入和安全门禁

1. 迁移前复制 `~/.claude/projects`、`~/.codex` 和目标数据库。
2. 先 dry-run，再抽样检查，最后才写入。
3. 审查 hooks 是否真实注册；仅看到 MCP tool 名称不算通过。
4. 检查 Git、Markdown、SQLite、云端 memory、handoff packet 是否含 API key、私钥、token 或不应共享的 raw transcript。
5. 锁定 Claude、Codex、插件和转换器版本；每次升级后重新执行 round-trip。
6. 团队采用前核验许可证，特别是：AICoder Viewer 当前未声明 license、amux 的 Commons Clause、openwolf 的 AGPL-3.0。
7. 云端方案额外核验数据处理、保留、删除、训练使用和跨 worktree 隔离策略。

## 十一、来源索引

### 客户端和格式

- [AGENTS.md](https://github.com/agentsmd/agents.md)
- [OpenAI Codex AGENTS.md 指南](https://developers.openai.com/codex/guides/agents-md)
- [Claude Code memory 文档](https://code.claude.com/docs/en/memory)
- [Cursor Rules 文档](https://cursor.com/docs/context/rules)
- [Model Context Protocol 架构文档](https://modelcontextprotocol.io/docs/learn/architecture)

### 会话迁移和 handoff

- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
- [hiShare](https://github.com/harrychih/hiShare)
- [claude-codex-switch](https://github.com/gitgoready/claude-codex-switch)
- [UniSessions / session-export](https://github.com/vibheksoni/session-export)
- [UniSessions PyPI](https://pypi.org/project/unisessions/)
- [UniSessions 数据保真说明](https://github.com/vibheksoni/session-export/blob/main/docs/data-fidelity.md)
- [claude-codex-mcp-bridge](https://github.com/WebisityStudio/claude-codex-mcp-bridge)
- [claude-codex-mcp](https://github.com/maferick/claude-codex-mcp)
- [plugin-handoff](https://github.com/ulpi-io/marketplace)
- [claude-session-port](https://github.com/TomSOhm/claude-session-port)

### 双端记忆和本地记忆

- [Mem0](https://github.com/mem0ai/mem0)
- [Supermemory](https://github.com/supermemoryai/supermemory)
- [Claude Supermemory adapter](https://github.com/supermemoryai/claude-supermemory)
- [Codex Supermemory adapter](https://github.com/supermemoryai/codex-supermemory)
- [Claude-Mem](https://github.com/thedotmack/claude-mem)
- [PAXM](https://github.com/pax-beehive/paxm)
- [PAXM Codex hook 配置](https://github.com/pax-beehive/paxm/blob/main/plugins/paxm-memory/hooks.json)
- [PAXM cross-agent acceptance 记录](https://github.com/pax-beehive/paxm/blob/main/docs/evals/cross-agent/results/2026-07-11-tracer.md)
- [Engram](https://github.com/Gentleman-Programming/engram)
- TrueMemory（仓库链接待补充；本次核验基于其 adapter、hooks 和 release/PyPI 信息）
- [OpenAI Codex hook 配置源码](https://github.com/openai/codex/blob/d52478c52ef09f001142a4b82339467c3880877f/codex-rs/config/src/hook_config.rs)
- [OpenAI Codex hooks 配置文档](https://github.com/openai/codex/blob/d52478c52ef09f001142a4b82339467c3880877f/docs/config.md)
- [openwolf](https://github.com/cytostack/openwolf)
- [Agent Memory Vault](https://github.com/mcncarl/agent-memory-vault)
- [mnemonic](https://github.com/danielmarbach/mnemonic)
- [memex](https://github.com/iamtouchskyer/memex)
- [mem-zero](https://github.com/sworcery/mem-zero)
- [MemoryGraph](https://github.com/memory-graph/memory-graph)
- [Cloudflare MCP Memory](https://github.com/beach55607-max/mcp-memory-server)
- [memtrace](https://github.com/syncable-dev/memtrace-public)
- [Memorix](https://github.com/AVIDS2/memorix)
- [opencode-claude-memory](https://github.com/kuitos/opencode-claude-memory)
- [opencode-claude-code-memory](https://github.com/kuitos/opencode-claude-code-memory)
- [context-mode](https://github.com/mksglu/context-mode)
- [memsearch](https://github.com/zilliztech/memsearch)
- [memsearch PyPI](https://pypi.org/project/memsearch/)
- [memsearch releases](https://github.com/zilliztech/memsearch/releases)
- [memsearch issue #631：项目目录/collection 分叉](https://github.com/zilliztech/memsearch/issues/631)
- [claude-memory-mcp](https://github.com/WhenMoon-afk/claude-memory-mcp)
- [claude-memory-mcp protocol](https://github.com/WhenMoon-afk/claude-memory-mcp/blob/main/docs/protocol.md)
- [claude-memory-mcp releases](https://github.com/WhenMoon-afk/claude-memory-mcp/releases)
- [claude-memory-mcp on Glama](https://glama.ai/mcp/servers/WhenMoon-afk/claude-memory-mcp)

### 规则、查看器和编排

- [Rulesync](https://github.com/dyoshikawa/rulesync)
- [ai-rules-sync](https://github.com/PanisHandsome/ai-rules-sync)
- [AICoder Session Viewer](https://github.com/seastart/aicoder-session-viewer)
- [Recensa](https://github.com/S40911120/recensa)
- [sx](https://github.com/JacobLinCool/sx)
- [session-exporter](https://github.com/p2o51/session-exporter)
- [amux](https://github.com/mixpeek/amux)

## 最终判断

目前最可靠的思路不是寻找一个万能同步产品，而是接受各层的事实边界：

- 用 **Rulesync** 同步规则和 agent 配置；
- 用 **Engram** 或经过数据治理的双端 memory adapter 同步项目长期知识；
- 用 **hiShare** 或 `codex-plugin-cc` 处理明确触发的一次性任务交接；
- 用 **sx**、AICoder Viewer、`session-exporter` 或 Recensa 搜索、导出和审计历史；其中 `session-exporter` 只读汇总，不提供导入或 resume；
- 用 **amux** 管理并行 worker 和运行状态；
- 把 `memtrace` 视为共享代码图/episodes/决策后端，把 Memorix 视为共享项目记忆库，把 PAXM 视为共享 SQLite + lifecycle hooks 的结构化记忆后端，把 TrueMemory 视为同一 DB 路径下由 Claude/Codex hooks 异步写入、后续会话召回的持久记忆后端，把 memsearch 视为依赖同一 Git root、Markdown 日志、collection 和 Milvus 配置的条件共享摘要记忆，把 `claude-memory-mcp` 视为多客户端共享本地历史的只读派生索引；这些方案都不是聊天全文实时合并或 Claude↔Codex 原生同步器；
- 把 `opencode-claude-memory` 视为 OpenCode 与 Claude 风格 Markdown 的兼容层，把 `context-mode` 视为显式统一数据目录后的持久化事件/快照后端，而不是 Claude↔Codex 原生同步器。

真正决定能否采用的，不是 README 上的“支持 Claude/Codex”，而是目标版本上的 nonce round-trip、迁移 fixture、secret 检查、namespace 隔离、许可证和升级回归结果。
