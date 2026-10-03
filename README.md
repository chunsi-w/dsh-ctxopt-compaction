# dsh-ctxopt-compaction

DeepSeek Harness 的上下文压缩插件，当前版本 **0.0.1**。在宿主原有压缩流程上增加收益判断、有界摘要缓存、显式记忆控制，以及保留诊断信息的工具输出裁剪。

适合长对话、代码排查和大量工具日志场景。压缩仍由模型生成摘要，不能保证所有历史信息都被保留。

## 功能

| 能力 | 行为 |
| --- | --- |
| 压缩收益判断 | 按实际待替换历史估算收益，排除未被替换的 system 消息；默认不足 512 估算 token 的片段跳过摘要调用。 |
| 摘要质量与预算 | 摘要过短、超预算或节省不足时拒绝替换，保留原历史；默认不额外重试退化摘要。 |
| 摘要缓存 | 按会话、输入、工具历史、路由及配置区分缓存，限制条数、字节数和有效期。 |
| 可控记忆 | 通过明确指令保存、更新、删除键值事实与待办，将当前状态写入压缩 checkpoint。 |
| 诊断保留 | 裁剪长工具输出时，在头尾之间保留预算允许的中段错误、文件、工单等诊断信息。 |

引擎与裁剪器是同一个插件的两个组件。历史选区、工具调用配对、事务提交和会话重放继续使用宿主实现。

## 环境要求

- Node.js **≥20**，ES modules。
- 已安装依赖并构建完成的 DeepSeek Harness；此前适配环境为 **0.2.0-rc.2**，commit `639ed015397290b3745d163aafe02ffee4aa3f84`。
- 宿主提供 `package.json` 中声明的 peer dependencies，包括压缩引擎、工具裁剪、LLM、会话与 Schemastery。
- API、模型及模型上下文窗口在宿主中配置，本插件不保存 API Key。

这是宿主插件，不能作为独立聊天服务运行。其他宿主版本需要重新验证兼容性。

## 获取与打包

```sh
git clone https://github.com/chunsi-w/dsh-ctxopt-compaction.git
cd dsh-ctxopt-compaction
npm pack
```

源码为 JavaScript，无需转译。生成的包名为 `dsh-ctxopt-compaction-0.0.1.tgz`；打包本身不需要启动模型或 Web 服务。

### Headless 加载

仓库内的 `cordis.patch.yml` 面向宿主的 headless 顶层组合：插入本插件两个组件，并禁用同层的默认压缩引擎与裁剪器。

在已准备好的宿主源码目录执行，替换插件的绝对路径：

```sh
pnpm dsh plugin --profile headless add file:/absolute/path/to/dsh-ctxopt-compaction
pnpm dsh --profile headless --dump-config
```

先检查生成配置中是否包含 `ctxopt-compaction` 和 `ctxopt-tool-result-pruner`，并确认同层默认组件已禁用。以上命令使用宿主的 bundle 安装机制；本仓库没有提供独立安装器。

### Web 加载

Web 的 Standard 预设在 `compaction` 隔离组中创建引擎。**仅安装顶层 bundle 或直接传入仓库的 `cordis.patch.yml`，不足以替换该组内的默认组件。**

配置 Web 时，以当前宿主的 `packages/bundle/web-app/presets/standard.patch.yml` 为准：

1. 将现有 Standard 预设的完整 `config` 放入一份 `- id: preset-standard` 的覆盖配置中，保留其他工具和隔离组。
2. 在其中的 `compaction` 组内，将 `compaction-basic` 的 `name` 改为本仓库 `src/engine.js` 的绝对路径，将 `tool-result-pruner` 的 `name` 改为 `src/pruner.js` 的绝对路径。
3. 分别在这两项的 `config` 中填写引擎和裁剪参数，将完整文件保存为 `ctxopt-web.patch.yml`。

下面仅展示组内两项的替换内容，**不是完整 Web 覆盖文件**：

```yaml
- id: compaction-basic
  name: /absolute/path/to/dsh-ctxopt-compaction/src/engine.js
  config:
    thresholdRatio: 0.4
    headroomTokens: 512
    retainTokens: 1400
    maxTokens: 1536
    compactionRetries: 1
- id: tool-result-pruner
  name: /absolute/path/to/dsh-ctxopt-compaction/src/pruner.js
  config:
    thresholdChars: 8192
    headChars: 4096
    digestChars: 1536
    tailChars: 1024
```

在宿主源码目录检查完整覆盖配置，再启动：

```sh
pnpm dsh web --patch /absolute/path/to/ctxopt-web.patch.yml --dump-config
pnpm dsh web --patch /absolute/path/to/ctxopt-web.patch.yml --no-open --port 3180
```

打开启动日志打印的完整 URL，使用 Standard 预设创建会话。切换插件或配置后重启 Web 进程；已经写入旧会话的 checkpoint 不会因重启而消失。

源码路径加载不会自动生成已安装插件的管理卡片。插件列表是否显示名称，与当前会话是否使用本插件是两件事；需要结合加载日志和执行事件确认。

## 压缩、缓存与记忆配置

以下为引擎 `config` 的可调字段。前五项是针对 32K 窗口的示例，其他数值为本插件默认值；实际窗口大小仍由宿主模型配置决定。

```yaml
thresholdRatio: 0.4
headroomTokens: 512
retainTokens: 1400
maxTokens: 1536
compactionRetries: 1

budgets:
  minRegionTokens: 512
  minSavingsTokens: 96
  checkpointReserveTokens: 128
  maxCheckpointTokens: 2048
  maxExtrasTokens: 384

cache:
  enabled: true
  maxEntries: 16
  maxBytes: 262144
  ttlMs: 300000
  failureTtlMs: 30000

memoryBlock: true
reminders: true
memory:
  maxItems: 8
  maxTodos: 4
  maxItemChars: 160
  allowedKeys: []

anchorValidation: true
degenerateGate: true
degenerateRetries: 0
economics:
  enabled: false
```

宿主 patch 会替换目标条目的整个 `config`，不会递归合并；调整时应保留仍需使用的其他配置。

| 参数 | 含义与边界 |
| --- | --- |
| `thresholdRatio` / `headroomTokens` | 控制宿主触发压缩的位置和窗口余量，不是输入的硬截断上限。 |
| `retainTokens` | 近期完整消息的最低保留预算；大消息和工具配对可能使实际保留量更高。 |
| `maxTokens` | 摘要模型输出上限；摘要调用仍会消耗模型用量。 |
| `maxCheckpointTokens` | 用于计算摘要预算，需扣除 `checkpointReserveTokens`；最终 checkpoint 由宿主计量。 |
| `maxExtrasTokens` | 显式记忆、待办和诊断补齐共享的估算 token 预算。 |
| `cache.maxEntries` / `maxBytes` | 每个引擎实例的缓存条数和键/序列化载荷字节上限。不是进程 RSS，也不是供应商 KV 缓存大小。 |
| `cache.ttlMs` | 摘要缓存有效期；访问、写入或读取统计时清理过期条目，没有后台清理定时器。 |
| `cache.failureTtlMs` | 确定性拒绝结果的短期缓存；模型网络错误和取消不写入该缓存。 |
| `memory.allowedKeys` | 允许保存的键名白名单；空数组表示不限制键名。 |

需要较小占用时，可设缓存 **4 条 / 65536 字节**、记忆 **4 条**、待办 **2 条**、`maxExtrasTokens: 192`。预算不足时按整条舍弃，不保证所有条目都进入摘要。

- 关闭摘要缓存：`cache.enabled: false`。
- 关闭全部附加记忆及诊断补齐：`memoryBlock: false`、`reminders: false`、`anchorValidation: false`。
- 重启或卸载引擎会清空进程内缓存。程序接口 `clearCache()` 也可清空，`cacheStats()` 可读取计数；它们不是聊天命令或页面按钮。

## 控制记忆和待办

在用户消息中单独写以下指令行，发送时不要放在代码块或引用内：

```text
MEMORY project=ATLAS
MEMORY schema=v3
TODO release=完成回归测试后发布
```

同一个键再次赋值表示更新；删除、完成和清空的写法：

```text
MEMORY schema=v4
FORGET project
DONE release
MEMORY RESET
```

也支持 `记住 schema=v4`、`忘记 project`、`待办 release=验证发布`、`完成 release`、`取消待办 release`、`清空记忆`。

键名区分大小写，允许 1–64 个 ASCII 字母、数字、下划线、点或连字符。条数超限时淘汰较早更新的条目；单条值超出 `maxItemChars` 时跳过整条。

这些规则在包含指令的历史被压缩时应用，状态保存在 checkpoint 的 `<ctxopt-memory-v1>` 块中。工具输出、assistant 消息、代码块和引用中的类似文字不会作为用户指令执行。

待办只是摘要中的未完成状态，不是定时提醒。本插件没有独立的长期记忆库，也不跨会话共享这些条目。`FORGET` 和 `MEMORY RESET` 只清除插件管理的当前状态，不擦除原始聊天日志或模型摘要里的历史叙述。

## 工具输出裁剪

裁剪器的独立配置默认值：

```yaml
thresholdChars: 8192
headChars: 2048
digestChars: 1536
tailChars: 2048
smartDiagnostic: true
```

`headChars`、`digestChars`、`tailChars` 分别控制头部、诊断摘要和尾部预算，按 Unicode code point 计数；设 `tailChars: 0` 可关闭智能裁剪路径的尾部保留。分隔符和围栏也计入最终阈值。

智能裁剪适用于单个文本块。混合内容、内部异常或无法满足缩小条件时回退宿主裁剪；`smartDiagnostic: false` 也会使用宿主算法。

## 判断是否生效

观察同一次运行中的宿主日志和会话结果：

- `ctxopt loaded: version=0.0.1`：引擎已创建，日志包含生效配置。
- `ctxopt decision`：记录会话、片段规模、摘要决定、模型等待时间、本地处理时间及缓存计数。
- `skip-small-region`：历史片段太小，保留原文而不调用摘要模型。
- `summary-ready` / `cache-hit`：生成可提交摘要或复用摘要；`cached-rejection` 表示复用拒绝决定。
- `ctxopt smart-prune`：本插件实际裁剪了工具文本，并记录前后字符数。

加载日志只能证明实例存在；还应检查执行日志及宿主的压缩提交/工具结果事件。缓存计数包含拒绝缓存，不能直接解释为模型回答缓存命中率。`localMs` 不包含模型等待，也不包括宿主的选区和事务提交。

## 仓库结构与测试范围

```text
dsh-ctxopt-compaction/
├── src/
│   ├── engine.js       # 压缩引擎和预算判断
│   ├── cache.js        # 有界 LRU 摘要缓存
│   ├── memory.js       # 显式记忆与待办状态
│   ├── pruner.js       # 工具输出裁剪器
│   └── text-utils.js   # 文本处理与诊断提取
├── cordis.patch.yml    # headless bundle 配置
├── package.json
├── .gitignore
├── LICENSE             # MIT 许可全文
└── README.md
```

此仓库保留插件本体；测试脚本和既有测试环境另行保存在本地 `p2-optimization` 项目中，不随本仓库上传。这里没有 `tests/`、Web 自动化脚本或性能原始报告，不提供 `npm test` 验收入口。

迁移宿主、模型或参数后，应分别运行原始宿主与本插件，验证长对话关键事实、记忆更新/删除、工具诊断、失败恢复和会话重放。延迟与 token 收益依赖实际输入及模型服务，本 README 不承诺固定提升比例。

## 许可

MIT，与 `package.json` 中的声明一致。
