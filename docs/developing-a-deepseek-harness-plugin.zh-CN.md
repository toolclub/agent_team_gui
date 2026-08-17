# 从零开发一个 DeepSeek Harness 插件

这是一篇尽量精简、可以直接照着操作的入门教程。我们会制作一个最小插件：启动 DeepSeek
Harness 时，它会在终端打印一行文字。

本文采用纯 JavaScript，不需要 TypeScript、打包工具、数据库或前端框架。理解这个最小结构后，
再继续开发工具、服务或 Web UI 会轻松很多。

> DeepSeek Harness 目前仍是 developer preview，升级时可能出现不兼容变化。开发前请查看
> [官方 README](https://github.com/deepseek-ai/deepseek-harness) 和当前版本说明。

## 1. 准备环境

安装当前 DeepSeek Harness 支持的 Node.js 版本，然后确认 Harness 可以启动：

```sh
npx @deepseek-ai/dsh web
```

浏览器能够打开 `http://127.0.0.1:3080` 就说明环境正常。这个命令来自
[DeepSeek Harness 官方运行说明](https://github.com/deepseek-ai/deepseek-harness#run)。

如果你是从 Harness 源码运行，请在 Harness 仓库根目录使用：

```sh
pnpm install
pnpm run build
pnpm dsh web
```

## 2. 创建最小目录

新建一个目录：

```text
dsh-hello-plugin/
├── package.json
├── index.js
└── cordis.patch.yml
```

这三个文件分别负责：

- `package.json`：声明这是一个可安装的 dsh bundle。
- `index.js`：插件真正执行的代码。
- `cordis.patch.yml`：告诉 dsh 启动时加载哪个插件入口。

官方把这种带配置层的可安装包称为 **bundle（组合包）**。详细概念见
[官方打包与安装教程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)。

## 3. 编写插件代码

创建 `index.js`：

```js
export const name = 'hello-plugin'

export function apply(ctx) {
  console.log('[hello-plugin] plugin loaded!')
}
```

一个最小 Cordis 插件只需要导出 `apply` 函数。加载插件时，框架会把 `ctx` 上下文传进来；以后
注册工具、监听事件或使用其他服务，都通过这个 `ctx` 完成。

官方说明：

- [`apply(ctx)` 与第一个插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.zh.md)
- [Cordis 第一个插件教程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/01-first-plugin.zh.md)

## 4. 声明可安装 bundle

创建 `package.json`：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": [
    "index.js",
    "cordis.patch.yml"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

最关键的是 `dsh.bundle.patch`。缺少它时，包虽然可能安装成功，但 dsh 不会自动启用插件层。

然后创建 `cordis.patch.yml`：

```yaml
- insert:
    - id: hello-plugin
      name: dsh-hello-plugin
```

注意：

- `id` 在最终配置中必须唯一。
- `name` 使用 `package.json` 里的包名。
- 不要用配置行的位置控制启动顺序；插件依赖应使用 `inject` 声明。

## 5. 本地安装与验证

在包含 `dsh-hello-plugin` 目录的上级目录执行：

```sh
npx @deepseek-ai/dsh plugin --profile demo add -w ./dsh-hello-plugin
```

`-w` 表示把依赖加入该 profile 的 pnpm workspace 根；省略后，部分版本会提示
`ERR_PNPM_ADDING_TO_ROOT`。

先查看合成配置，不启动应用：

```sh
npx @deepseek-ai/dsh --profile demo --dump-config
```

输出中应该出现类似内容：

```text
# == dsh-hello-plugin
- id: hello-plugin
  name: dsh-hello-plugin
```

然后启动：

```sh
npx @deepseek-ai/dsh --profile demo
```

终端出现下面这行就说明插件已经工作：

```text
[hello-plugin] plugin loaded!
```

修改插件代码后，应重启正在运行的 dsh 进程。刷新浏览器不能替换 Host 中已经加载的模块。

卸载插件：

```sh
npx @deepseek-ai/dsh plugin --profile demo remove -w dsh-hello-plugin
```

Profile、bundle 与配置层的关系可参考
[官方架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)。

## 6. 使用其他 dsh 能力

如果插件依赖某项服务，需要声明 `inject`。例如依赖工具注册服务：

```js
export const name = 'my-tool-plugin'
export const inject = ['tools']

export function apply(ctx) {
  // 运行到这里时，ctx.tools 已经可用。
}
```

框架会等依赖就绪后再加载插件。插件卸载时，通过 `ctx` 注册的监听器、工具和其他 effect 也会
自动清理。

### 为什么有些项目没有 `apply` 函数？

Cordis 支持三种插件形态：

1. 函数插件：模块导出 `apply(ctx)`。
2. 对象插件：默认导出带有 `apply(ctx)` 方法的对象。
3. 类插件：默认导出继承 `Service` 的类。

当插件需要向其他插件提供长期存在的服务时，通常会采用第三种形态。例如本项目把业务逻辑
分到 application/domain/infrastructure 层，组合根 [`src/index.ts`](../src/index.ts) 使用的是：

```ts
export class AgentTeamService extends ExecutionApplicationService {
  static inject = [
    'storageDomain', 'tools', 'subagents', 'llm',
    'agents', 'sessions', 'systemPrompt',
  ]

  static Config = z.object({
    defaultProvider: z.string().default('spawn'),
    // 其余配置字段……
  })

  constructor(ctx: Context, config: AgentTeamConfig) {
    super(ctx, config)
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(agentTeamDomainSpec)
    // 挂载数据表，然后注册工具、RPC、system prompt 与对话编排。
  }
}

export default AgentTeamService
```

`ExecutionApplicationService` 最终继承 Cordis `Service`，并在它的基类构造函数中注册
`agentTeamGui` service。Loader 加载默认导出的类并创建实例，`Service` 生命周期会调用
`[Service.init]()`；所以不需要再额外导出 `apply`。函数插件最适合入门，类插件适合提供
`ctx.agentTeamGui` 这类可被其他插件使用的长期 service。

需要用户配置时，不要把参数硬编码在代码中。应导出 `Config` 类型和同名 Schemastery schema，
让错误配置在加载时直接失败。完整示例见
[官方插件配置教程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.zh.md)。

## 7. 发布到 GitHub

这个示例直接发布 JavaScript，因此不需要额外构建步骤。推送到 GitHub 并创建版本标签后，用户可
以固定版本安装：

```sh
npx @deepseek-ai/dsh plugin --profile web add -w github:your-name/dsh-hello-plugin#v0.1.0
```

建议始终使用 tag 或 commit SHA，不要让生产环境自动跟随不断变化的 `main`。

如果改用 TypeScript，Git 安装得到的是源码，不会自动运行普通的 `build` 命令。你需要提供一个
自包含的 `prepare` 脚本来生成运行入口；pnpm 10 及以上还要求用户明确授权该构建脚本。官方文档
对此有专门说明：
[从 GitHub 安装的构建要求](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md#从-github-安装构建脚本这道坎)。

## 8. 发布前检查清单

- [ ] `package.json` 包含 `dsh.bundle.patch`。
- [ ] `cordis.patch.yml` 的插件 `id` 唯一。
- [ ] `--dump-config` 中能看到 bundle 和插件行。
- [ ] 全新 profile 可以安装并启动。
- [ ] 插件失败时给出明确错误，不静默跳过。
- [ ] 可调参数没有硬编码，而是使用 schema 配置。
- [ ] README 写清兼容版本、安装、验证和卸载命令。
- [ ] GitHub 安装使用 tag 或 commit SHA。

## 下一步

掌握最小插件后，可以按以下顺序继续：

1. [官方：开发一个工具](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.zh.md)
2. [官方：插件生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/index.zh.md)
3. [官方：服务与依赖](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/service.zh.md)
4. [官方：事件系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/events.zh.md)
5. [完整社区插件示例：dsh-agent-team-gui](https://github.com/toolclub/dsh-agent-team-gui)

最重要的原则是：**先做一个能稳定安装和卸载的最小插件，再逐步增加工具、持久化、RPC 和 UI。**
