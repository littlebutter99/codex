# Dicode

独立的 TypeScript 终端客户端，使用 pi-tui 渲染前端，连接官方预编译 Codex 的 `app-server`。
需要 Node.js 24+；无需编译 Rust。

## 发布包

在 Linux x86_64 构建机运行 `npm ci --workspaces=false` 后执行 `npm run package`。
脚本下载并校验固定版本的 Node.js 和 Codex 官方发布包，生成：

- `dist/dicode-linux-x64.tar.gz`：Linux x86_64。
- `dist/dicode-windows-x64.zip`：Windows x86_64。

两个包都包含对应平台的 Node.js、Codex 和依赖，不需要另装 Node 或编译 Rust。
使用系统终端运行；Windows 使用 PowerShell 或 Windows Terminal。ARM 设备不在本次构建范围内。

Linux 解压后执行 `./install.sh`，Windows 解压后在 PowerShell 执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

重新打开终端后，可以在任意项目目录运行 `dicode`、`dicode --check` 或
`dicode login deepseek`。安装在当前用户目录，无需管理员权限；卸载使用解压包中的
`./uninstall.sh` 或 `powershell -ExecutionPolicy Bypass -File .\uninstall.ps1`。

发布包的状态默认保存在 Linux 的 `$XDG_STATE_HOME/dicode`（未设置时为 `~/.local/state/dicode`）
或 Windows 的 `%LOCALAPPDATA%\Dicode`。可以通过 `DICODE_STATE_DIR` 指定目录。
源码目录 `.state` 中已有的登录信息不会自动复制到发布包状态目录；首次使用可重新登录。
Windows 文件访问权限由所在用户目录的 ACL 控制。Codex 原生登录仍使用其自身的用户配置。

发布包包括官方 Codex 的配套执行文件；Windows 沙箱的系统设置和权限要求以 Codex 的运行环境为准。

## 启动

```bash
cd /workspaces/codex/agent-cli
npm ci --workspaces=false
npm start -- --check
npm start -- --cwd /workspaces/codex
```

默认调用本目录下的 `vendor/codex`。已下载 Linux x86_64 的官方 0.165.0
预编译文件，校验值与下载链接记录在 `vendor/release.json`。二进制不加入 Git。

默认复用已有 Codex 登录和配置；需要登录 OpenAI/Codex 时运行：

```bash
./vendor/codex login
```

Codex 原生登录凭据由 Codex 管理。DeepSeek 使用下面的独立登录入口。
可以用 `--codex /absolute/path/to/codex` 或 `CODEX_BIN` 指定其他二进制。
更换版本后应重新验证协议兼容性。

## 登录 DeepSeek

```bash
npm start -- login deepseek
# 或预选模型
npm start -- login deepseek --model deepseek-v4-pro
```

输入 DeepSeek 平台的 API Key，随后选择 `deepseek-flash` 或 `deepseek-v4-pro`。
Key 输入以圆点显示，不进入对话或命令历史。登录通过官方 `GET https://api.deepseek.com/models`
检查凭据和可用模型，不发送项目文件，也不执行模型推理。余额、配额及推理能力以实际任务结果为准。

登录成功后直接运行：

```bash
npm start -- --cwd /workspaces/codex
```

在已有界面中输入 `/login` 或 `/login deepseek`，也能登录并立即切换到新 DeepSeek 会话。
Esc 或 Ctrl+C 取消登录；验证或连接失败时保留原有会话。切换提供商会创建新会话，
不会把原对话自动发送给新的提供商。

凭据以本地 JSON 文件保存至 `.state/auth/deepseek.json`，目录权限 `0700`、文件权限 `0600`；
这是本地文件保存，不是加密保险库。该目录已被 Git 忽略。启动 Codex 时通过子进程环境变量
传入 Key，不放入进程命令参数，也不改写 `~/.codex/config.toml`。

已保存的 DeepSeek 配置会成为本 CLI 的启动默认。临时使用原有 Codex 配置：

```bash
npm start -- --provider codex
```

也可以不保存 Key，使用终端中已有的 `DEEPSEEK_API_KEY` 环境变量：

```bash
npm start -- --provider deepseek --model deepseek-flash
```

`/logout` 删除本 CLI 保存的 DeepSeek 凭据并切回 Codex 配置。终端环境中的 Key 由用户自行管理。
`/model` 读取当前提供商的 Codex 模型目录；DeepSeek 目录固定包含上述两个模型，
用于声明工具和上下文能力，登录时仍通过 DeepSeek API 检查账户返回的模型。

DeepSeek 通过 Responses API 接入；默认使用 HTTP 流式传输、关闭内置网页搜索。
模型元数据放在 `config/deepseek-models.json`。
参考：[DeepSeek 官方 Codex 集成说明](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)
与 [Codex 提供商配置](https://developers.openai.com/codex/config-reference/)。

```bash
npm start -- --cwd /path/to/project --model YOUR_MODEL
npm start -- --cwd /path/to/project --continue
npm start -- --cwd /path/to/project --resume THREAD_ID
```

`--continue` 按工作目录和提供商读取本 CLI 保存的最近会话 ID。
完成第一轮任务后才保存新会话；Codex 不持久化尚未执行任务的空会话。
状态保存在 `.state/`，不加入 Git；会话正文仍由 Codex 管理。

## 交互

全屏终端界面采用固定的项目与模型栏、可滚动对话区、任务状态栏和多行编辑器。
实际模型名称取自 Codex 创建或恢复会话的响应，未指定 `--model` 时展示后端选择的模型。
对话支持 Markdown，命令输出与文件 diff 分开展示。工具输出较长时显示末尾 20,000 字符；
实时消息默认保留 200 个条目；手动加载的历史会扩展当前记录，完整会话仍由 Codex 管理。

顶部右侧显示模型与思考强度，待应用的设置标为“下轮生效”。输入框下方的状态栏显示工作状态、上下文占用估计、
最近一轮 Token 和会话累计 Token；未收到后端数据时显示等待状态。

- `/sessions` 打开会话面板，按当前工作目录和提供商筛选；输入标题搜索，↑/↓ 选择、Enter 恢复。
  长列表支持“加载更多”。其他窗口正在写入的会话不能同时接管，界面会说明原因并保留当前会话。
- 恢复时自动回显最近 15 轮的用户消息、Agent 回复、命令结果和文件 diff。`/history` 继续向前分页加载。
- `/model` 打开模型面板；`/model 模型名称` 可直接选择。只使用后端返回的目录，不臆测可用模型。
- `/effort` 展示当前所选模型支持的强度；也支持 `/effort high` 等直接设置。不支持的值会被拒绝。
  模型和强度在下一轮请求中传给 Codex，继续使用同一个会话；恢复另一会话时读取该会话的配置。
- `/usage` 查看最近一轮、缓存命中、推理输出及累计用量。上下文比例采用最近请求用量作近似值，
  不使用累计 Token 除以窗口大小；不估算费用。恢复历史后，若后端尚未返回用量，等待下一次事件。

模型、思考强度和会话选择直接在底部输入区展开，不使用居中弹窗。上方对话保持可见，
列表最多显示 6 项，仅在列表下方展示当前选中项的说明。搜索框与原输入区衔接，
底部快捷键提示随选择状态更新。支持本地过滤或远程标题搜索；远程搜索有防抖，并忽略过期返回。
Esc 或 Ctrl+C 收起列表，返回原编辑器草稿。选项支持鼠标点击确认，或 ↑/↓ 后 Enter 确认。窄窗口自动压缩列表高度和次要说明。

直接输入任务，Enter 提交；Alt+Enter 换行，Tab 补全命令和路径，↑/↓ 浏览已发送输入。
鼠标滚轮查看对话，离开底部时不强制跟随新消息。连续输入在同一会话内运行。
运行中可编辑下一条草稿；提交会提示等待或取消，保留草稿。

离线预览界面（不启动后端、不调用模型）：

```bash
npm run demo
```

演示中输入 `/sessions`、`/model`、`/effort`、`/usage` 或 `/approval` 查看对应界面，`/exit` 退出。
演示中的历史、模型选择和用量均为示例数据，不调用模型服务。

| 命令 | 功能 |
| --- | --- |
| `/login` | 登录 DeepSeek 并切换到新会话 |
| `/logout` | 移除本地 DeepSeek 凭据并切回 Codex 配置 |
| `/help` | 帮助 |
| `/new` | 开始新会话 |
| `/resume ID` | 恢复会话 |
| `/sessions` | 搜索并选择当前项目与提供商的会话 |
| `/history` | 加载更早的历史消息 |
| `/model` | 模型选择面板 |
| `/effort` | 思考强度选择面板 |
| `/usage` | Token 用量详情 |
| `/status` | 工作目录、提供商、模型、会话 ID、二进制路径 |
| `/cancel` | 取消当前任务 |
| `/exit` | 退出 |

任务运行时 Esc 或 Ctrl+C 发起取消；空闲时 Ctrl+C 退出。任务结束前不能提交新任务。
命令、已完成的文件变更和 MCP 工具结果默认显示简短预览；点击工具结果可展开或收起详情，Ctrl+O 可展开或收起所有工具结果。
命令失败时预览末尾的错误信息。待审批的文件变更仍展示完整提议，便于判断。
审批弹窗独立接收输入，关闭后恢复编辑器草稿；支持 PgUp/PgDn 查看长请求。
命令与文件审批只有输入 `y` 才接受，并且只接受本次操作；回车或 Esc 拒绝。
权限申请明确展示申请内容，输入 `y` 时按本轮授权。
普通用户提问支持编号选择或自由文本。任意 MCP 表单暂不支持，会明确拒绝。
恢复会话会分页回显历史，后端保留完整上下文。

默认请求 `workspace-write` 沙箱和 `on-request` 审批，并将审批交给用户。
组织托管配置可能限制这些设置；失败时显示后端返回的错误。
工作目录决定 Codex 操作的项目，本客户端与 Codex 在同一台机器上运行。

## 重新下载二进制

以下步骤针对 Linux x86_64，固定版本及 SHA-256，不跟随 latest 自动更新：

```bash
mkdir -p vendor
curl -fL https://github.com/openai/codex/releases/download/rust-v0.165.0/codex-x86_64-unknown-linux-musl.tar.gz -o vendor/codex.tar.gz
echo 'be635d3486a5bd060d0fff582ae6d30160280c31344dd85719707fa920e187f0  vendor/codex.tar.gz' | sha256sum -c -
# 仅在校验成功后继续
tar -xzf vendor/codex.tar.gz -C vendor
mv vendor/codex-x86_64-unknown-linux-musl vendor/codex
./vendor/codex --version
```

其他系统请下载官方发布页中对应平台的文件，验证其发布校验值，再通过 `--codex` 指定。

## 开发与验证

```bash
npm test
npm start -- --check
```

测试覆盖 RPC 响应乱序、初始化、服务器审批、恢复会话、快速完成、取消和后端退出。
`--check` 使用真实下载的二进制验证握手，不发起模型请求。
实际模型调用需要可用登录与网络；通过 `DEBUG=1 npm start` 查看后端诊断信息。

- `src/client.ts`：stdio 子进程及双向 RPC，超时和退出处理。
- `src/session.ts`：会话和轮次生命周期。
- `src/backend.ts`：提供商运行时、审批和后端连接生命周期。
- `src/auth.ts`：DeepSeek 配置、私有凭据文件、API 验证和子进程参数。
- `src/login.ts`：隐藏 Key 输入、模型选择和取消登录。
- `src/approvals.ts`：审批队列、取消、用户问题。
- `src/cli.ts`：终端输入、事件展示和本地会话 ID 保存。
- `src/ui.ts`：pi-tui 全屏布局、多行编辑、Markdown、工具记录、审批弹窗。
- `src/panels.ts`：可搜索选择面板、远程分页和过期响应处理。
- `src/theme.ts`：统一终端配色和输出清理。
- `src/usage.ts`：Token 格式化、上下文占用估计及用量说明。
- `src/types.ts`：当前使用的协议数据类型。

前端固定依赖 `@earendil-works/pi-tui@1.4.0`，使用项目当前官方包名，
不是 oh-my-pi 分支。安装版本由本目录的 `package-lock.json` 锁定。
文档：[pi-tui 源码与用法](https://github.com/earendil-works/pi/tree/main/packages/tui)。

协议字段根据下载的 0.165.0 二进制生成结果核对。
可通过 `./vendor/codex app-server generate-ts --out /tmp/codex-protocol` 查看该版本类型。
参考：[官方 app-server 文档](https://developers.openai.com/codex/app-server)。
