# Debug README：隔离运行与真实终端调试

本文记录上下文压缩、thinking 状态和工具输出 UI 的实际调试方法。目标是运行真正的 CLI、控制请求时序、保存终端证据，同时不影响机器上已有的 CCB 实例。

## 1. 三种调试方式

| 方式 | 用途 | 是否内置 |
| --- | --- | --- |
| `--debug` / `--debug-file` | 查看产品内部日志 | 是 |
| Bun Inspector | 源码断点、检查变量 | 启动脚本支持 |
| PTY + 本地 SSE + 终端网格截图 | 可重复地驱动交互、复现时序与显示问题 | 否，是外部调试夹具 |

**打开 debug 日志不会自动启动模拟 API，也不会自动生成截图。** 下文的 `drive.py`、`control.py` 和 `/control/*` 都属于临时夹具，不是 CCB 内置命令或产品 API。

## 2. 不影响现有实例的底线

- 不使用 `pkill`、`killall`，不按 `ccb`、`claude`、`bun` 等进程名批量退出程序。
- 不停止、重启其他终端里的 CCB，也不清理旧 release 目录。
- 不覆盖安装目录、`current` 链接或其他实例正在使用的 bundle；代码分割产物可能在运行中继续加载。
- 每次新建临时目录，隔离 `HOME`、`CLAUDE_CONFIG_DIR`、`TMPDIR` 和工作目录。
- 不复制真实用户配置、OAuth 凭证或 API key；本地模拟 API 使用明确的假 key。
- 记录本次 `subprocess.Popen` 返回的 PID，只管理这个子进程和本次创建的服务。
- 正常结束时向自建 CLI 输入 `/exit`，确认退出后关闭本地服务。退出失败先保留现场，不用批量杀进程兜底。
- 调试本身不意味着提交、安装或发布；这些操作需要单独决定。

目录隔离不是操作系统沙箱。真实 Bash 工具仍具备当前用户的权限，因此只能运行已审阅、无破坏性的本地 fixture 命令。

## 3. 内置日志和源码断点

### 日志

以下命令适合在另一个终端新开普通实例，**会使用该终端的真实配置与服务，不是隔离模拟模式**：

```sh
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ccb-log.XXXXXX")"
ccb --debug-file "$LOG_DIR/ccb-debug.log"
```

当前参数注册见 `src/main.tsx`，日志实现见 `src/utils/debug.ts`：

| 参数 | 含义 |
| --- | --- |
| `-d, --debug [filter]` | 启用日志，可按类别过滤，例如 `--debug 'api,hooks'` |
| `--debug-file <path>` | 写入指定文件，同时启用 debug |
| `--debug-to-stderr` | 隐藏参数，将 debug 输出到 stderr |
| `--verbose` | 详细展示选项，不等同于 debug 日志 |

TUI 排查优先写文件，避免 stderr 日志混入终端画面。日志和原始终端记录可能包含提示词、路径、工具输出等敏感信息，对外分享前必须检查和脱敏。

### Bun Inspector

在源码根目录，依赖已经具备时：

```sh
BUN_INSPECT=127.0.0.1:9229 bun run dev
```

`scripts/dev.ts` 将该值传给子进程的 `--inspect-wait`，所以连接调试器之前等待是正常行为。选择未被占用的本地端口，不要为腾端口停止其他实例，也不要把 Inspector 暴露到公网。

`bun run dev:inspect` 目前通过 `scripts/dev-debug.ts` 固定设置 `localhost:8888/2dc3gzl5xot`，会覆盖外部 `BUN_INSPECT`。需要自选端口时使用上面的 `bun run dev` 方式。

开发入口会注入 `MACRO` 和 feature 参数，不要直接运行未经这些参数处理的 TSX 入口来替代它。当前 dev/build 都使用 `scripts/defines.ts` 的默认 feature 列表；复现时还应记录额外的 `FEATURE_*` 环境变量。以上 dev 命令本身也不会隔离用户配置。

## 4. 安全地构建调试副本

**不要直接使用原地 `bun run build` 来做隔离调试。** 当前 `build.ts` 开头会递归删除源码目录中的 `dist/`，可能影响仍在使用它的进程。

在源码根目录先确认状态，并新建独立输出位置：

```sh
git status --short
REPO="$(pwd -P)"
DEBUG_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ccb-debug.XXXXXX")"
```

制作 `$DEBUG_ROOT/build.ts` 临时副本，而不是修改仓库的 `build.ts`：

1. 将 `outdir` 改成新目录中的绝对路径 `$DEBUG_ROOT/dist`。
2. 删除副本里的 `rmSync` 清理步骤。每次使用新目录，不需要清空任何旧产物。
3. 把副本的 `./scripts/defines.ts` 导入改成当前 `$REPO/scripts/defines.ts` 的绝对路径。
4. 保留 `Bun.build` 的入口、defines、features、代码分割和 sourcemap 设置。
5. 保留构建后兼容处理、vendor 复制和 `cli-bun.js` / `cli-node.js` 入口生成。
6. 审阅副本，确认它没有向原 `dist` 或安装目录写入，再从源码根目录执行它。

副本准备好后，执行方式为：

```sh
bun run "$DEBUG_ROOT/build.ts"
```

这里必须保持工作目录为源码根目录，因为 entrypoint 和 vendor 来源仍使用相对路径。下一轮修改要输出到另一个新目录，不覆盖正在运行的调试 bundle。

运行时直接指定 Bun 和调试入口的绝对路径，不通过可能指向其他版本的 `ccb` 包装脚本。可以只读使用已经安装好的 Bun 二进制，但不要改动其所属 release。记录 Bun 版本、源码 HEAD、未提交 diff 和 bundle 路径，确保知道实际运行了哪份代码。

## 5. 隔离实例的结构

推荐每轮保留如下目录结构：

```text
<debug-root>/
  build.ts
  dist/
  drive.py
  control.py
  work/
    fixture.py
  run-1/
    home/
    config/
    tmp/
    ccb-debug.log
  events.jsonl
  terminal-1.ansi
  preview.txt
  preview.cells.json
  preview.png
```

其中 Python 脚本需要从已有夹具复制并适配，或按下面协议自行准备；仓库目前没有开箱即用的 `scripts/debug-*.py` 命令。

### 环境与启动参数

子进程环境使用明确的白名单字典，不直接复制 `os.environ` 后只覆盖两三个字段：

| 项目 | 设置 |
| --- | --- |
| `HOME` | 本轮 `home/` |
| `CLAUDE_CONFIG_DIR` | 本轮 `config/` |
| `TMPDIR` | 本轮 `tmp/` |
| 子进程 cwd | 独立的 `work/`，不在真实项目里执行 fixture |
| `ANTHROPIC_BASE_URL` | 本次绑定到 `127.0.0.1` 的模拟服务及随机端口 |
| `ANTHROPIC_API_KEY` | 假值，例如 `sk-ant-runtime-local-only` |
| `PATH` / `SHELL` | 仅提供 fixture 所需的已知程序 |
| `TERM` / `COLORTERM` / `LANG` | 明确终端能力和 UTF-8，例如 `xterm-256color`、`truecolor`、`en_US.UTF-8` |

不继承真实 provider、代理、MCP 和凭证环境。辅助开关可使用 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`、`DISABLE_AUTOUPDATER=1`、`DISABLE_TELEMETRY=1`、`DISABLE_ERROR_REPORTING=1`，并将 `NO_PROXY` 设为 `127.0.0.1,localhost`。这些开关**不构成严格断网保证**，需要网络隔离时应另设沙箱或网络策略。

通过 PTY 启动真实 `dist/cli-bun.js`，本次夹具使用了：

- `--bare`：减少自动发现与后台功能，不代表文件系统或网络沙箱。
- `--model claude-sonnet-4-5-20250929`：本地模拟服务使用的明确模型名。
- `--tools Bash`：限制内置工具范围。
- `--allowedTools Bash`：仅在已审阅的本地模拟场景中免去 Bash 确认；不要配合不可信服务使用。
- `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`：不加载真实 MCP；验证 MCP 时只替换为本地 stdio fixture 配置。
- `--debug-file <本轮日志绝对路径>`。

首次启动若出现 onboarding、工作目录信任或假 key 确认，应在隔离实例内处理。需要预置时，也只写本轮隔离配置，不修改真实 `~/.claude`。

工具输出场景可以关闭自动压缩和提示建议以减少干扰；调试压缩时则需启用或主动触发对应路径，不能照搬输出场景的配置。

## 6. 用本地 SSE 控制真正的调用链

运行链路：

```text
control.py → PTY 按键 → 真实 CLI → 本地 Anthropic 协议服务
                            ↓              ↓
                         真实工具 ← tool_use 流
                            ↓
                    tool_result 下一次请求 → 最终响应

PTY 原始输出 → ANSI 记录 → pyte 终端网格 → 文本 / 单元格 / PNG
```

本地服务使用 `ThreadingHTTPServer(('127.0.0.1', 0), ...)`，由系统分配端口，避免抢占其他服务。控制接口可以输入按键、读取画面、截图、调整终端大小和关闭本次服务；它们没有产品级认证，不得绑定公开地址或暴露给不可信调用方。

模拟 Anthropic 流的基本顺序是：

```text
message_start
content_block_start
content_block_delta（text_delta / input_json_delta / thinking_delta 等）
content_block_stop
message_delta（stop_reason、usage）
message_stop
```

fixture 应按目标版本的协议提供完整字段、正确的 block index 和消息关联。发送 `tool_use` 时，让 CLI 真正运行已知的本地命令；看到下一次请求中真实的 `tool_result` 后再结束场景，而不是直接伪造一段看起来像工具结果的文字。还需按实际调用处理非流式响应和 token 计数请求。

### 区分 UI 残留与请求并发

只看两个 spinner 同时出现，不能证明两个请求同时执行。复现时应：

1. 为请求分配 ID，记录单调时钟时间、请求类别、流开始/结束及客户端断开事件。
2. 在普通 thinking、thinking block 结束、压缩请求开始、摘要 block 结束等位置设置可控暂停点。
3. 暂停时截图，再通过 PTY 输入 Esc 或下一条用户消息，记录操作时间。
4. 对照普通请求和压缩请求的活动区间，而不是仅比较文字出现时间。
5. 特别检查“摘要 block 已结束，但整个请求尚未结束”的取消窗口。

本地服务可确定协议和时序行为，但不等于验证了真实供应商的网络、认证或所有服务端行为。需要服务端兼容结论时，应另外安排经授权的真实 API 验证。

## 7. 终端交互与截图

### PTY 与输入

- 用 `os.openpty()`，将真实 CLI 的 stdin/stdout/stderr 接到 slave，启动独立会话并记录 PID。
- 设置初始窗口，例如 120 列 × 42 行；持续读取 master，保存原始字节。
- 正确处理 UTF-8 增量解码和终端查询，避免 CLI 等待光标位置或终端能力响应。
- 改变窗口大小时同时更新 PTY 和截图网格，仅通知本次子进程 `SIGWINCH`。
- 保持真实按键顺序：清输入、输入文字、回车分开发送。

本次遇到过整段快速写入 `/exit` 被当作普通粘贴文本的情况。夹具改为先单独发送 Ctrl+U，稍等后逐字发送 slash 命令，最后发送回车；不要因此判断产品退出功能坏了，更不要改用批量杀进程。

常用原始按键：Ctrl+O 为 `\x0f`，Esc 为 `\x1b`，Ctrl+U 为 `\x15`，回车为 `\r`。存在自定义快捷键时以当前界面显示为准。

场景完成优先等待可观测事件，例如本次 `tool_result` 请求或进程退出。截图前可以留少量渲染时间，但不要只靠固定睡眠判断请求已结束。

### 保存什么证据

| 文件 | 用途 |
| --- | --- |
| `events.jsonl` | 请求与输入的时间线，区分真实调用与 UI 状态 |
| `terminal-N.ansi` | 原始终端输出，保留控制序列供复查 |
| `*.txt` | 当前可见终端网格文字，便于比较 |
| `*.cells.json` | 每个单元格的字符、前景色、背景色和样式 |
| `*.png` | 根据真实网格绘制的效果图 |
| `ccb-debug.log` | 产品内部诊断，与外部事件相互印证 |

本次截图使用 Python 的 `pyte` 解码终端、Pillow 绘制网格。这是对真实运行输出的重建，不是系统终端窗口截图，也不是完整终端模拟器。字体回退、组合字符、宽字符、斜体和 OSC 链接可能与原生终端不同；遇到异常要回看原始 ANSI，并在原生终端复核。

macOS 可以用 `open <截图绝对路径>` 打开保存的 PNG。

## 8. 建议复现的边界与已知限制

工具输出的检查应覆盖空输出、1/6/7/8 行、末尾换行、内部空行、窄窗口、长单行、中文、组合重音、JSON、显式 ANSI 色、跨行样式、Ctrl+O 全文以及返回折叠。首尾放不同标记，才能看出是否丢失、重复或取错末尾。

本次运行中观察到的限制，不应被截图成功掩盖：

- **大输出先被上游截断。** Bash 默认保留约 30,000 字符（见 `src/utils/shell/outputLimits.ts`）；UI 的尾部只能来自它收到的数据，不能恢复原始多 MB 输出的真正最后几行。
- **MCP 成功结果正文为空。** 本地 fixture 的工具调用和返回成功，但 UI 未显示正文；在已安装的 `8464dcca` 基线也复现。不能把它计作共享文本预览或链接渲染验证通过。
- **失败工具有独立渲染路径。** Bash 非零退出并不一定经过成功结果的 `OutputLine`；也不能用输出里的“ERROR”一词代替语义错误色验证。
- **截图解码器有边界。** 本次 `pyte` 对部分天城文组合字符解析异常，而原始 ANSI 中仍有完整内容；中文和普通组合重音验证不能代表所有 Unicode 字符都覆盖了。
- **颜色通过不代表链接通过。** 需另外在支持 OSC 8 的原生终端检查链接及样式边界。
- **环境问题要单独记录。** 插件背景提示、vendor 二进制缺库等不能悄悄忽略，也不能直接算作本次 UI 修改的回归。

运行证据应写明哪些路径经过了真实交互、哪些被阻断。构建成功、类型检查、单元测试或直接调用内部函数都不能替代 TUI 行为证据；它们各有其他用途。

## 9. 复用本次临时夹具

以下是 2026-09-13 本机调试留下的参考资料，不是仓库依赖，`/tmp` 被清理后可能不再存在：

| 路径 | 内容 |
| --- | --- |
| `/tmp/ccb-output-gradient.MfeVMq/drive.py` | PTY、本地 SSE、截图和子进程管理 |
| `/tmp/ccb-output-gradient.MfeVMq/control.py` | 按键、场景、主题、resize、退出控制 |
| `/tmp/ccb-output-gradient.MfeVMq/work/fixture.py` | 输出边界场景 |
| `/tmp/ccb-output-gradient.MfeVMq/mcp.py` | 本地 stdio MCP fixture |
| `/tmp/ccb-output-gradient.MfeVMq/verified-dark-preview.png` | 首尾渐变效果图 |
| `/tmp/ccb-compact-fixed.c4E6Pq/drive.py` | 较早的压缩时序调试参考 |

**这些服务已结束，不要直接拿旧 `port` 文件连接，也不要原样重跑旧目录的 `drive.py`。**

复用时先复制需要的脚本到全新目录，并逐项检查：

- Bun 路径、bundle 路径、工作目录和本地 MCP 路径。
- `build.ts` 的 defines 导入：旧副本还指向改名前的 `claude-code-release`，当前源码目录已改名。
- Python 依赖路径：旧脚本引用另一临时目录的 `pydeps`，并不是系统默认可用依赖。
- 字体路径：旧截图脚本使用 macOS 的 Menlo，其他平台需要适配。
- `RUN` / `REQUEST` 起始值、截图文件名和配置写入位置，避免覆盖历史证据。
- 本地服务只监听回环地址；假 key 不改成真实 key。

仅在完成适配、启动新的 `drive.py` 并确认其 ready 事件后，才可在另一个终端使用对应目录的控制脚本。下面的 `DEBUG_ROOT` 指新夹具目录，不是旧证据目录：

```sh
python3 "$DEBUG_ROOT/control.py" case rows12 preview
python3 "$DEBUG_ROOT/control.py" input $'\x0f'
python3 "$DEBUG_ROOT/control.py" capture expanded
python3 "$DEBUG_ROOT/control.py" input $'\x0f'
python3 "$DEBUG_ROOT/control.py" resize 64 42
python3 "$DEBUG_ROOT/control.py" capture narrow
python3 "$DEBUG_ROOT/control.py" theme light
python3 "$DEBUG_ROOT/control.py" case rows8 light-boundary
python3 "$DEBUG_ROOT/control.py" exit
```

这些命令的具体语义以复制的 `control.py` 为准。本次版本的 `theme` 会先 `/exit` 当前自建实例，再以独立配置启动新实例；`exit` 会退出 CLI，再请求关闭本次服务。

## 10. 收尾

1. 保存截图、原始 ANSI、时间线、日志和对应源码 diff，记录未覆盖的路径。
2. `/exit` 退出本次实例，确认子进程退出码，再关闭本地服务和 PTY。
3. 只核对本次记录的 PID；若 PID 仍存在，先确认它是否仍是原子进程，不对其他进程采取动作。
4. 查看 `git status` 和 diff，确认没有改到真实配置、安装产物或无关源码。
5. 保留需要的证据；不要自动清理其他临时目录或旧 release，也不要把含敏感内容的日志提交到仓库。
