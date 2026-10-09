# DSHDirect

> **一个不注册任何模型工具的 MCP 直连管理器。** MCP 连接完全运行在独立子进程里，宿主的 MCP 常驻内存开销为 **0**——这正是本项目的存在理由，因为 DSH 自带的 `@deepseek-ai/dsh-mcp-client` 会把每个 MCP 工具注册进 `ctx.tools`，在堆内存已接近上限的宿主上，这一注册就是压垮 V8 的最后一次分配。

- **CLI** —— `mcp-direct add <name> <url>` 一行注册服务器，并自动生成全局 `<name>-mcp` 命令和一份教会模型走直连路线的技能。
- **插件** —— 在 Web GUI 内提供管理界面：列表、探活、查看 schema、调用工具、增删服务器。

两个入口共用一份 `lib/core.js` 和同一个 `servers.json`，**CLI 与 GUI 结构上不可能漂移**。

> English: [README.md](README.md)

---

## 为什么存在

崩溃不是"感觉上会崩"，而是可以精确定位到一次分配：

1. 宿主是 Electron 进程，V8 堆上限约 **4 GB**，日常使用已爬升到接近上限。
2. `dsh-mcp-client` 的工作方式是：连接 MCP 服务器 → 把**每一个 MCP 工具注册进 `ctx.tools`**。
3. 该路径会把 `@modelcontextprotocol/client` 加载进**宿主进程**——约 **27 MB 常驻内存，且 GC 无法回收**（它是模块图，不是临时垃圾）。
4. 于是"**打开 MCP 管理页**"这个动作，变成了压垮堆的**最后一次分配**：

```
OOM error in V8: MarkCompactCollector ... 3938.9 (4074.0) MB
```

崩溃点非常具体：**`POST /list` 处理器**——整条链路里宿主第一次 `require()` MCP SDK 的地方。在此之前一切正常，就在这一下，进程死了。

### 核心不变量

```
绝不向宿主工具运行时注册任何 MCP 工具——一个都不注册。
```

这不是优化，是设计前提。为了守住它，所有 MCP 工作都被赶出宿主：

```
GUI (client.js)
  │  fetch POST（仅 loopback）
  ▼
宿主 bridge (index.js)      → 只做注册表 IO 与进程编排，绝不 require SDK
  │  spawn
  ▼
mcp-worker.js                → 短命子进程：干活、打一行 JSON、退出
  │  require
  ▼
@modelcontextprotocol/client → 官方 SDK，进程级隔离
```

于是宿主的 MCP 相关常驻内存为 **0**，一个挂死或崩溃的 MCP 服务器最多只能杀掉一个子进程。

---

## 解决的痛点

| # | 痛点 | 传统 MCP 桥 | 本方案 |
|---|---|---|---|
| 1 | **宿主 OOM 崩溃** | 打开 MCP 页面即崩，会话与页面连接全丢 | SDK 只在子进程加载，宿主零常驻开销 |
| 2 | **一台挂死的服务器拖垮宿主** | 服务器无响应 → 宿主卡死 | 每次操作独立子进程 + 硬超时（默认 20 s），到点必杀 |
| 3 | **工具数量污染上下文** | N 台 × M 个工具全塞进模型工具表，撑爆上下文、拖慢每轮 | 一个工具都不注册；模型按需调 `<name>-mcp` 命令 |
| 4 | **CLI 与 GUI 各写一份配置、互相打架** | 命令行加过的服务器界面看不到；界面改的 CLI 不认 | 单一真源 `servers.json`，`lib/core.js` 双侧共用 |
| 5 | **没有 UI** | 加服务器要手编 JSON、猜工具名猜参数 | 图形化管理：列表 / 探活 / schema / 试调 / 增删 |
| 6 | **不知道为何连不上** | 裸抛 `MODULE_NOT_FOUND` 或静默失败 | 失败时列出**所有尝试过的路径**；列表页逐台显示工具数、耗时、错误原文 |
| 7 | **SDK 路径硬编码踩坑** | 指向一份**过时的残留副本**，而真实运行的是另一份安装 | 四级探测，**运行中的解释器**排最前 |
| 8 | **模型不知道有这条直连线** | 仍去走会崩的 dsh-mcp-client 路径 | `add` 时**自动生成技能**，明写：不要用 MCP 工具，用这条命令 |

### 第 3 点：这是取舍，不是缺陷

DSH 原生思路是把 MCP 工具变成模型工具让模型直接调。本插件**主动放弃**这个能力，换成**命令行网关 + 技能**：

- 模型看到的是"有一台 `cocos` MCP 服务器，用 `cocos-mcp` 命令操作它"——**而不是** 22 个工具定义。
- 需要参数时先 `cocos-mcp schema <tool>` 拿 `inputSchema`，再 `call`。
- 代价：多一步 schema 查询。收益：宿主不崩、上下文不被工具表撑爆。

**在 4 GB 堆上限面前，这个取舍是唯一能活下来的方案。**

---

## 仓库结构

```
.
├─ packages/
│  ├─ cli/                    CLI（共享核心在这里）
│  │  ├─ mcp-direct.js        命令行入口
│  │  ├─ package.json        (dsh-mcp-direct-cli)
│  │  └─ lib/
│  │     ├─ core.js           SDK 解析 / 注册表 / 连接 / 产物生成（共享）
│  │     └─ mcp-worker.js     每个 MCP 操作一个进程
│  └─ plugin/                 DSH Desktop 插件包（dsh-mcp-direct）
│     ├─ package.json         manifest（bundle patch + dsh.client）
│     ├─ cordis.patch.yml     插入 id=mcp-direct 的插件行
│     ├─ index.js             宿主半：bridge 路由 + 安全守卫
│     ├─ client.js            客户端半：管理界面
│     └─ icon.svg
├─ tests/
│  ├─ run.js                  套件入口
│  ├─ unit/core.test.js       纯函数单测（无网络、无 SDK）
│  ├─ host/unit 插件宿主      plugin-host.test.js（含安全守卫用例）
│  ├─ e2e/cli.test.js         真实 CLI × 真实 stdio MCP 服务器
│  └─ fixtures/echo-server.js 无依赖的 MCP 测试服务器
├─ docs/
│  ├─ architecture.md         设计决策与依据
│  └─ troubleshooting.md      连不上时查什么
├─ LICENSE
└─ README.md / README.zh-CN.md
```

插件从 CLI 包加载 `lib/core.js`——这就是两个表面背后只有一个实现的原因。

---

## 安装

### 环境要求

- Windows（生成的启动器是 `.cmd`；Node 代码本身可移植）
- Node.js 18+ **或** DSH Desktop 安装（启动器会回退用 `ELECTRON_RUN_AS_NODE=1` 把桌面二进制当纯 Node 用，无需独立 node）
- `@modelcontextprotocol/client` SDK **内置在 DSH Desktop 应用里**，运行时解析，不 vendored

### 1. 只用 CLI

```powershell
git clone https://github.com/weimingyu9312/DSHDirect.git
cd DSHDirect\packages\cli
node mcp-direct.js list
```

要把 `<name>-mcp` 变成全局命令，把 CLI 目录加进 `PATH`：

```powershell
node mcp-direct.js add cocos http://127.0.0.1:3100/mcp
cocos-mcp tools
```

### 2. 安装插件

插件加载 CLI 包里的共享 `lib/core.js`，所以 CLI 必须存在。约定布局：

```
<bin>/                     ← 在 PATH 上
├─ tools/dsh-mcp-direct/   ← packages/cli 的内容放在这里
│  ├─ mcp-direct.js
│  └─ lib/
└─ <name>-mcp.cmd          ← 生成的启动器落在这里
```

然后把你自己的 DSH profile 指向插件目录：

```powershell
dsh plugin --profile desktop add <repo>\packages\plugin
```

插件的 patch 行**刻意不带配置**。所有路径在代码里检测：

| 路径 | 默认 |
|---|---|
| `toolDir` | `MCPD_HOME` → `~/.dsh/tools/dsh-mcp-direct` → PATH 中含 `tools/dsh-mcp-direct` 的目录 |
| `registryPath` | `<toolDir>/servers.json` |
| `binDir` | `MCPD_HOME` → 传统 `tools/dsh-mcp-direct` 布局的 PATH 目录 → `toolDir` |
| `skillsDir` | `%USERPROFILE%\.dsh\skills` |
| `probeTimeoutMs` | `8000` |

只有**迁移 CLI 位置**时才需要在 `cordis.patch.yml` 里写 `config:`。保持无配置很重要——profile 以 `patchReload: live` 运行，一个与默认值不同的配置会让条目在每次启用/禁用时被 reconcile；叠加 Plugin Manager 写入的 `disabled: true` 行，会形成 **reconcile 死循环**：宿主反复重载、活动页面连接 `ECONNRESET` 断掉。

装完**重启 DSH Desktop**——bundle 只在 boot 时加载。

---

## CLI 参考

```
mcp-direct list                         列出已注册服务器（逐个探活）
mcp-direct add <name> <url> [--header K=V ...]
mcp-direct add-stdio <name> <command> [args...]
mcp-direct remove <name>
mcp-direct tools <name>                 列出某服务器的工具
mcp-direct schema <name> <tool>         查看某工具 inputSchema
mcp-direct call <name> <tool> <json>    调用工具（argv | MCPD_ARGS | stdin）
mcp-direct probe <name>                 重连并报告工具数
```

选项：`--home <dir>`、`--bin-dir <dir>`、`--skills-dir <dir>`、`--json`、`--help`、`--version`。

环境变量：

| 变量 | 作用 |
|---|---|
| `MCPD_HOME` | 注册表与启动器目录 |
| `MCPD_SERVER` | 生成的启动器设置它，可省略服务器名 |
| `MCPD_ARGS` | JSON 形式的工具参数——Windows 下最稳的传参方式 |
| `MCPD_SDK_DIR` | 覆盖 `@modelcontextprotocol/client` 包目录 |
| `MCPD_APP_ROOT` | 插件宿主传给 worker 子进程 |

### 传参

命令行 JSON 在 Windows 上很脆：cmd 和 PowerShell 都会在脚本看到之前重写引号。优先用 `MCPD_ARGS`：

```powershell
$env:MCPD_ARGS = '{"action":"is_ready"}'
cocos-mcp call cocos_scene
```

JSON 非法时，报错会**回显收到的原文 + 来源**（argv / MCPD_ARGS / stdin），引号问题一眼可见而不是玄学。

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | CLI 错误（名字非法、服务器未注册、连接失败、JSON 非法） |
| 2 | 工具执行了但返回 `isError` |

---

## GUI

在「设置 → 插件 → dsh-mcp-direct」：

1. **服务器列表** —— 名称、传输、端点、工具数、探活状态（配色区分成败）、耗时
2. **测试连接** —— 单台按需探活，不阻塞整表
3. **工具详情** —— 工具清单 + `inputSchema` 参数表（含 enum 可选项、必填标记）
4. **调用面板** —— 按 schema 预填必填参数骨架，执行并展示结果
5. **添加服务器** —— HTTP / stdio 两种传输，校验与宿主一致（`^[a-z0-9][a-z0-9-]*$`、`http(s)://`）
6. **移除** —— 二次确认后清理注册表与生成产物

样式只用 `--dsw-alias-*` 主题令牌，随明暗主题自动切换；未 import 任何 `@deepseek-ai/dsh-client-ui-*` 包。

---

## 安全边界

bridge 能改磁盘文件、能拉起进程，因此唯一授权边界是请求准入：

- 来源地址是 loopback（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`）
- `Host` 头解析为 loopback
- `Sec-Fetch-Site` 不得为 `cross-site`
- 若有 `Origin`，必须与 `Host` 同源
- 仅接受 `POST`（`GET` 回答 `405`）
- body 上限 64 KiB

浏览器侧另有宿主信任层（进程令牌 cookie），未认证的 `/api/*` 一律 `403`。

**服务器 header / env 值绝不发给 GUI**——只发键名。

---

## 测试

```powershell
node tests/run.js          # 全部套件
node tests/run.js unit     # 纯函数，无子进程
node tests/run.js host     # 插件宿主
node tests/run.js e2e      # CLI × 真实 stdio MCP 服务器
```

e2e 用 `tests/fixtures/echo-server.js`（无依赖的 MCP 服务器）在一次性 `MCPD_HOME` 里跑真实 CLI。

> **沙箱提示。** 受限 Windows 沙箱下，子进程无法捕获它自己子进程的管道 stdio（`spawn EPERM`）。runner 会检测并报 `SKIP`（不是假失败），unit/host 仍照常运行。在沙箱外重跑可得完整结果。宿主进程本身不受沙箱限制，所以运行时 worker 正常。

---

## 已知限制

- **stdio 传输在受限沙箱内无法测试**：受限模式下管道 stdio 子进程被拒（`spawn EPERM`）。HTTP 不受影响且已端到端验证；宿主进程不在沙箱内，运行时 stdio 功能正常。
- 不支持 MCP `resources` / `prompts` 读取。
- 不实现 MCP 提示词模板。
- 生成的启动器是 Windows `.cmd`；Node 代码跨平台，但启动器层在其它系统需要 `.sh` 版本。
- 每次调用重建连接，无跨调用会话状态；工具调用为单次原子操作，无流式输出。

---

## License

MIT —— 见 [LICENSE](LICENSE)。