# dsh-agent-team-gui

[English](README.md) | [简体中文](README-zh.md)

`dsh-agent-team-gui` 是 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness)
的实验性 Agent 与小队编排组合包。它保存可复用的 Agent 定义、把 Agent 组成小队，并允许模型通过
`dispatch_to_squad` 工具分派任务。每个成员都可以使用不同的现有 dsh 模型路由与不同的工具
allow/deny 列表。API key 始终由 dsh 的 provider 与凭据配置管理；本插件不会存储 API key。

> [!WARNING]
> dsh 与本插件目前都是 developer preview。本插件面向 dsh `>=0.1.0-rc.5 <0.2.0`，并要求
> Node.js 22.19 或更高版本。dsh 在稳定版之前可能有破坏性变更；需要可复现时请同时锁定 dsh
> 与本插件版本。

## 核心差异

小队不必共享同一个模型配置。每个 Agent 都能独立选择 dsh 中已有的 provider/model 路由、
`maxTokens` 和工具 allow/deny 策略；这些 Agent 可保存为可复用定义，再组合为不同小队。派单时可选择
串行或并行执行，以及 `spawn`、`fork` 或串行专用的 `chain` 上下文模式，并通过 Web 面板管理和观察结果。

## 状态与架构

```text
用户对话
   |
   v
dispatch_to_squad（模型工具）
   |
   +-- 串行 / 并行执行
   +-- spawn / fork / chain 上下文
   |
   +--> Agent A --> 已配置的 dsh provider/model
   +--> Agent B --> 已配置的 dsh provider/model
   `--> Agent C --> 已配置的 dsh provider/model
              |
              `--> 聚合结果 + append-only 会话事件

Agent 与小队定义 --> dsh storage-domain --> JSON 后端

dsh Web 输入框旁“小队”按钮 --> client 面板 --> loopback Connection RPC --> 宿主服务
```

本包包含 Web client、仅 loopback 可用的 Connection RPC、宿主服务、持久化注册表和模型派单工具。
输入框旁的**小队**按钮会打开 **Agent 小队**面板，可在其中管理定义并向当前打开的对话派单。
provider/model 选项来自 dsh 已有的模型配置。

当前能力：

- 通过 dsh `storage-domain` 持久化 Agent 与小队记录。
- 用 Web 表单创建、编辑、删除 Agent 与小队，并从已配置模型中选择路由。
- 输入框旁小队按钮，以及面向当前对话的直接派单面板。
- 每个 Agent 独立的 `{ provider, model, maxTokens? }` 路由与工具限制；不存储 API key。
- 模型可调用 `dispatch_to_squad`，可选显式指定每个 Agent 的任务。
- 支持串行或并行，以及 `spawn`、`fork`、串行专用的 `chain` 上下文模式。
- 每个成员都有明确的成功/失败结果；一个成员失败不会静默取消其余成员。
- 父会话 append-only 的 `tool/call` 与 `tool/result` 记录完整派单输入/输出，每个成员结果包含
  子会话/run ID。

## 前置条件

- 版本为 `>=0.1.0-rc.5 <0.2.0` 的 dsh **Web profile**。本组合包不支持 headless 或裸 profile。
- Node.js 22.19 或更高版本。
- `PATH` 中有 pnpm。下文 Git 安装说明中的限制适用于 pnpm 10 及更高版本。
- dsh 中已经配置至少一个 provider/model 路由。请通过 dsh Settings 或其凭据机制配置凭据，
  不要把凭据写入本插件记录。

下列命令假设使用已安装的 `dsh` 可执行文件。若从源码 checkout 运行 dsh，请先构建该 checkout，
再把 `dsh ...` 替换为 `pnpm --dir /path/to/deepseek-harness dsh ...`。

## 从本地目录安装

在包含 `agent_team_gui` 的目录中逐条执行。

1. 安装插件开发依赖：

   ```sh
   pnpm --dir ./agent_team_gui install
   ```

   预期：pnpm 成功结束，并创建或更新 `agent_team_gui/node_modules`。

2. 链接进 profile 前构建 checkout：

   ```sh
   pnpm --dir ./agent_team_gui run build
   ```

   预期：命令以状态 0 退出，并在 `agent_team_gui/lib/` 下生成运行时入口。

3. 把本地组合包加入 Web profile：

   ```sh
   dsh plugin --profile web add -w ./agent_team_gui
   ```

   预期：pnpm 报告已加入 `dsh-agent-team-gui`；dsh 不应打印包“declares no dsh.bundle”的警告。

4. 不启动应用，检查组合后的配置：

   ```sh
   dsh --profile web --dump-config
   ```

   预期：输出包含 `dsh-agent-team-gui` 组合包层与 `agent-team-gui` 行。

5. 启动 profile：

   ```sh
   dsh --profile web
   ```

   预期：dsh 正常启动，对话输入框旁出现**小队**按钮。若启用了宿主 info 级日志，日志还会包含
   `[agent-team-gui] durable registry and dispatch_to_squad ready`。

## 从 tarball 安装

已构建的 tarball 包含编译产物，因此不需要安装脚本授权。

1. 安装依赖并构建：

   ```sh
   pnpm --dir ./agent_team_gui install
   pnpm --dir ./agent_team_gui run build
   ```

   预期：两条命令均以状态 0 退出，且 `agent_team_gui/lib/` 存在。

2. 生成 tarball：

   ```sh
   pnpm --dir ./agent_team_gui pack
   ```

   预期：pnpm 打印生成的归档文件名，通常是 `dsh-agent-team-gui-0.1.0.tgz`。下一步请使用你的
   pnpm 版本实际打印的完整路径。

3. 安装该归档：

   ```sh
   dsh plugin --profile web add -w ./agent_team_gui/dsh-agent-team-gui-0.1.0.tgz
   ```

   预期：pnpm 报告已加入 `dsh-agent-team-gui`，且没有 `allowBuilds` 提示。若 `pack` 把归档写到
   其他位置，请替换成实际路径。

4. 验证组合包层：

   ```sh
   dsh --profile web --dump-config
   ```

   预期：dump 中包含 `dsh-agent-team-gui` 层与 `agent-team-gui` 行。

## 从 GitHub 安装

Git 依赖只包含源码，而不是预构建的发布产物。因此本仓库提供自包含的 `prepare` 路径来构建运行时
入口，不依赖相邻的 dsh monorepo checkout。

你也可以直接对拥有终端权限的 DeepSeek Harness Agent 发送下面这一句话：

> 根据 https://github.com/toolclub/agent_team_gui 仓库的 README，把插件安装到 DeepSeek Harness
> 的 web profile；解析 main 当前 commit 并锁定该 SHA，按 README 配置 pnpm `allowBuilds`，最后用
> `dsh --profile web --dump-config` 验证安装。

1. 锁定并安装已经审查的 commit：

   ```sh
   dsh plugin --profile web add -w github:toolclub/agent_team_gui#<commit-sha>
   ```

   pnpm 10 及以上版本首次执行时的预期：安装可能失败，因为 pnpm 会阻止 Git 依赖的 `prepare`
   脚本。pnpm 会打印**精确的包键**，dsh 会打印需要修改 `pnpm-workspace.yaml` 的 profile 目录。

2. 把 pnpm 打印的键原样加入该 profile 的 workspace 文件。使用默认 dsh home 时，编辑
   `~/.dsh/profiles/web/pnpm-workspace.yaml`；设置了 `DSH_HOME` 时编辑
   `$DSH_HOME/profiles/web/pnpm-workspace.yaml`：

   ```yaml
   allowBuilds:
     dsh-agent-team-gui: true
   ```

   预期：YAML 保留已有 workspace 设置，并在 `allowBuilds` 下包含 pnpm 打印的键。若 pnpm 打印
   了其他键，不要猜测。

3. 重新执行同一条锁定 commit 的安装命令：

   ```sh
   dsh plugin --profile web add -w github:toolclub/agent_team_gui#<commit-sha>
   ```

   预期：pnpm 获准运行 `prepare`，完成构建并报告包已加入。

4. 验证组合包层：

   ```sh
   dsh --profile web --dump-config
   ```

   预期：dump 中包含 `dsh-agent-team-gui` 层与 `agent-team-gui` 行。

> [!CAUTION]
> `allowBuilds` 表示授权该包在安装时于你的机器上执行代码。这些代码运行在所有 dsh agent 沙箱
> 之外。只放行源码可信的包，审查所选 revision，并用 `github:owner/repo#<sha>` 锁定 commit，
> 防止后续 push 静默改变实际执行内容。使用已构建 tarball 可避免此构建授权。

## 配置

组合包会插入以下宿主行：

```yaml
- id: agent-team-gui
  name: dsh-agent-team-gui
  config:
    defaultProvider: spawn
    defaultExecutionMode: serial
    defaultContextMode: spawn
```

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `defaultProvider` | `string` | `spawn` | 派单/上下文没有选择其他 provider 时使用的已注册 dsh subagent provider。 |
| `defaultExecutionMode` | `serial \| parallel` | `serial` | 默认成员调度方式。 |
| `defaultContextMode` | `spawn \| fork \| chain` | `spawn` | `spawn` 启动无父上下文的新子 Agent；`fork` 包含父会话已完成 turn 的前缀；`chain` 把每个串行成员的文本传给下一位。 |

若要覆盖某个 profile，请编辑 `$DSH_HOME/profiles/<name>/cordis.patch.yml`：

```yaml
- id: agent-team-gui
  config:
    defaultProvider: fork
    defaultExecutionMode: parallel
    defaultContextMode: fork
```

dsh patch 行会整体替换 `config`，不会深合并。覆盖该行时请重写所有需要的字段。`chain` 只能与
串行执行搭配。

Agent 记录字段：

| 字段 | 必填 | 含义 |
|---|---|---|
| `name` | 是 | 显示名称。 |
| `systemPrompt` | 是 | 传给子 Agent 的角色/persona。 |
| `provider` | 是 | 已存在的 dsh provider 路由名。 |
| `model` | 是 | 该 provider 下已有的 model id。 |
| `maxTokens` | 否 | 单 Agent token 上限。 |
| `toolScope.allow` / `toolScope.deny` | 否 | 应用于该子 Agent 的 dsh 工具名限制。 |

小队记录包含 `name`、可选的协作说明与有序的 Agent ID 列表。一个 Agent 可以属于多个小队。
**Agent 小队**面板通过仅 loopback 可用的宿主 RPC 编辑这些记录。插件只保存路由名称，不保存或
复制 provider 密钥。

### 同进程 Service API

插件作者也可以在同进程直接使用该注册表：

```ts
const agentId = await ctx.agentTeamGui.createAgent({
  name: 'Reviewer',
  systemPrompt: 'Review for correctness and cite concrete evidence.',
  provider: 'your-configured-provider',
  model: 'your-configured-model',
  toolScope: { allow: ['bash', 'str_replace_editor'] },
})

const squad = await ctx.agentTeamGui.createSquad({
  name: 'Release review',
  collabNote: 'Run independent checks, then consolidate findings.',
  members: [agentId],
})
```

Service 还提供两类记录的 get/list/update/delete 方法、`addMemberToSquad`、
`removeMemberFromSquad`、`exportDefinitions`/`importDefinitions` 与可编程 `dispatch` 方法。准确
TypeScript 签名以包导出的声明文件为准。

## 使用示例

### 自然语言派单（已有小队后可用）

```text
用户：把这个任务交给发布审查小队：检查补丁是否引入回归。
      让 reviewer 查正确性，test agent 并行运行重点测试。

助手：[调用 dispatch_to_squad，传入 squadId、task、
      assignments=[...]、executionMode="parallel"、contextMode="spawn"]

助手：小队返回了两个成员结果。Reviewer 发现……，重点测试……。
      任何失败成员都会被明确列出，而不会被省略。
```

由模型选择是否调用 `dispatch_to_squad`；本插件不会用正则解析用户文本。`squadId` 可以是持久化
ID，也可以是小队准确名称（不区分大小写）；若名称重复，必须使用持久化 ID。工具参数为
`squadId`、`task`，以及可选的 `assignments: [{ agentId, task }]`、`executionMode` 和
`contextMode`。

### 对话旁按钮派单

1. 启动 `dsh --profile web`，打开一个对话，点击输入框旁的**小队**。
2. 在 **Agent 小队**中创建 Agent。从 dsh Settings 已配置路由中选择 provider/model；可选填写
   max tokens 与逗号分隔的允许/禁用工具。
3. 创建小队、勾选成员，并可选填写协作说明。
4. 在**派发当前任务**中选择小队、执行方式和上下文方式，填写任务后点击**派单**。

```text
用户输入：检查这次修改并给出发布建议。
用户选择：发布审查小队 -> 并行 -> 派单

面板：[client 使用当前 live 对话作为 parent，请求宿主派单]
面板：completed — Reviewer：completed；Test agent：completed
```

直接结果显示在 overlay 中；按钮派单不会合成一条 assistant 对话消息。

### 定义导出/导入

**Agent 小队**面板可以把全部持久化定义导出/恢复为一个 JSON 文档。

- **导出**下载 `agent-team-gui-<日期>.json`，内容为 `{ "format": "agent-team-gui/definitions",
  "version": 1, "agents": [...], "squads": [...] }`——每条记录携带持久化 id 与模型路由（绝不包含
  API key）。
- **导入**读取该文件并按 **merge** 语义应用：文档中的行按 id upsert；文档未提及但已存在的行会
  保留；小队可以引用存储中已有的 agent。整个文档先做完整校验（结构、重复 id、模型路由、小队
  成员引用），因此被拒绝的导入不会写入任何数据。（持久化写入本身不是单一事务：中途存储失败可能
  留下部分应用的结果。）

进程内同样可用 `exportDefinitions()` 与 `importDefinitions(document, mode)`；`mode` 为 `merge`
（默认）或 `replace`。`replace` 让文档成为整个存储，此时小队只能引用文档内的 agent。

## 可观测性与失败行为

父会话的常规 `tool/call` 与 `tool/result` 事件会保留请求和完整聚合结果。若成员已经启动，其结果
会包含 provider 所有的 child session/run ID，可通过 dsh 现有 subagent/session 视图检查 trajectory。
宿主日志也会记录成员的开始/结束/失败。结果会区分完成、部分完成与失败成员。单个成员失败会连同
错误一起进入聚合结果，不会静默停止无关成员。插件不创建长驻子进程；Cordis 负责工具/监听器清理，
插件卸载时会关闭 storage domain。

## 卸载

通用形式是 `dsh plugin --profile <name> remove <pkg>`。本 Web 组合包执行：

```sh
dsh plugin --profile web remove dsh-agent-team-gui
```

预期：pnpm 移除依赖，dsh 从 profile 的组合包列表中移除 `dsh-agent-team-gui`。dsh 存储后端中的
持久化记录不会自动删除。

## 已知限制

- 仅支持 Web profile；本组合包依赖 dsh Web 的 storage、Connection RPC 与 browser module 服务，
  不支持 headless 或裸自定义 profile。
- 没有独立的 shell CLI/YAML 记录编辑器；请使用 Web 面板或同进程 Service API。
- 尚无自定义 `squad/*` 会话事件类型：当前树外插件 API 无法把它们注册到 dsh known-event catalog。
  可观测性依赖标准工具事件、子会话和宿主日志。
- storage domain 版本为 0；developer-preview 版本可能拒绝旧磁盘数据或要求迁移。
- dsh 在子 Agent 运行时验证模型路由名；provider/model 被删除或拼写错误时会形成明确的成员失败。
- `chain` 只能串行。大规模 fan-out 尚未使用 workflow engine 的并发控制。
- dsh API 尚未稳定，因此兼容范围有意限定为 `>=0.1.0-rc.5 <0.2.0`。

## Roadmap

- 为 Web 面板增加批量编辑和更丰富的逐 Agent 分工控制。
- 为持久化定义增加 schema migration。
- 为大规模小队增加有界并发与更丰富的 trajectory projection。

## 贡献指南

1. 创建 issue，说明行为与 dsh 版本。
2. 用 `pnpm install` 安装依赖，用 `pnpm run build` 构建。
3. 添加针对性测试，并按适用范围运行 `pnpm test`、`pnpm run typecheck` 和 `pnpm pack`。
4. 保持 RPC 仅限 loopback；绝不存储 API key；只使用在匹配源码版本中确认过的 dsh API。
5. 提交范围集中的 pull request，commit message 使用英文。

## 许可证

本项目按 [MIT License](LICENSE) 发布。
