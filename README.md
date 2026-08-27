# DSH Pet Client v2.1.4

DeepSeek Harness 的 Windows 桌面客户端——托盘 + 悬浮鲸鱼宠物 + **内嵌终端** + **Token HUD** + **微信通道**。

用 **Nim + webui + winim** 实现，双击运行即打开嵌入 WebView2 的 DSH 窗口。

> ⚠️ **重要：本版本要求 dsh web 部署在 WSL 中**（终端服务、词元统计、宠物状态联动均依赖 WSL 侧的配套服务），部署方式见下方「WSL 部署」。

## 亮点

| 指标 | 数值 |
|---|---|
| exe 体积 | ~900 KB |
| 内存占用 | ~27 MB |
| 启动 | 秒开（WebView2 初始化除外）|
| 渲染内核 | WebView2（Windows 自带，无需打包浏览器）|

## 功能

- 🖥️ **内嵌终端**：主窗口内直接打开 xterm 终端（非 iframe），直连 WSL 侧 3081 终端服务（真 PTY bash），支持自定义背景色 / 透明度 / 字号 / 字体，面板位置大小记忆
- 📊 **Token HUD**：右上角常驻面板，实时显示当日 输入 / 输出 / 缓存命中率 / 余额（DeepSeek 官方接口）
- 🐳 **四色悬浮鲸鱼宠物**：主窗口打开 = 蓝色，最小化 = 黑色，**需要你交互时（提问/审批）= 橙色心跳闪烁**，**回复完成 = 绿色常亮**（不再闪烁，窗口置前即停，托盘/任务栏图标同步变色）
- 📑 **消息大纲（左缘横杠）**：当前会话我的消息侧边导航——hover 展开大纲，点击跳转定位（黄色闪烁），收起态显示激活消息视口 10 条窗口
- 🖱️ **鼠标手势**：右键上拖 = 滚到页顶，右键下拖 = 滚到底，先上后下 = 刷新页面，**下→右（L 形，各段 ±30°）= 最小化客户端窗口**（等同点击最小化按钮，事件驱动零延迟）
- 🔍 **缩放浮标**：Ctrl+滚轮 / `+` / `-` / `0` 缩放页面，屏幕中央实时显示缩放百分比
- 🗂️ **已归档会话管理**：侧边栏设置按钮上方"已归档会话"面板——查看/打开/恢复/删除会话（删除有确认）
- ✒️ **界面字体设置**：设置页"界面"——系统字体选择 + 字号下拉（持久化，重启保留）
- 💬 **微信通道**（dsh-wechat 插件）：iLink bot 收微信消息 → agent 回复；本地 3082 send 服务主动推送（选股 `--push` 用）
- 🖥️ 托盘图标（左键 显示/最小化，右键 菜单：打开 / 宠物 / 退出）
- 🪟 WebView2 嵌入窗口，加载 `http://127.0.0.1:3080`（dsh web）
- 🔄 窗口异常消失自动重建；后端断连自动恢复
- 💾 窗口尺寸记忆；🔑 开机自启（可选）

## 架构

```mermaid
graph TD
    subgraph Windows
        A[DSH-Pet-Client.exe<br/>Nim 壳 + WebView2]
        A -->|加载页面| B[dsh web 页面 :3080]
        B --> C[dsh-term-panels 插件<br/>终端面板 / Token HUD / 悬浮按钮 / 消息大纲]
        A -->|读 pet-state.json| D[%USERPROFILE%\\pet-state.json]
    end

    subgraph WSL
        E[dsh web 后端<br/>dsh --profile web]
        F[3081 终端服务<br/>server.js + node-pty]
        G[today-usage.py<br/>词元聚合]
        H[ask-pending.py<br/>提问/审批检测]
        I[dsh-wechat 插件<br/>dsh --profile wechat]
        J[本地 send 服务 :3082]
        E -->|会话记录| S[(~/.dsh/sessions<br/>*.jsonl.zstd)]
        F -->|fs.watch 事件驱动| S
        F -->|写入状态| D
        I -->|iLink bot 收发| WX[(微信)]
        I -->|agent 会话| E
        I -->|POST /send| J
    end

    C -->|WebSocket /ws| F
    C -->|fetch /api/today-usage /api/balance| F
```

**数据流**：插件在页面里渲染终端/词元 → 通过 WebSocket 和 HTTP 连 3081 终端服务 → 服务在 WSL 里跑 bash、聚合会话记录 → 宠物状态写入文件，客户端 Nim 读取控制宠物颜色。微信通道由 dsh-wechat 插件（wechat profile 常驻）经 iLink bot 收发消息，本地 3082 send 服务供主动推送（如选股结果）。

## 目录结构

```
DSH-Pet-Client/
├── dsh_client_full.nim   # 客户端主源码（Nim）
├── dsh-term-panels/       # dsh web 前端插件（终端面板/HUD/按钮界面/消息大纲/鼠标手势/缩放浮标）
├── dsh-message-outline/   # 独立消息大纲插件（从 dsh-term-panels 抽出，纯前端零 3081 依赖）
├── dsh-wechat/            # 微信通道插件（iLink bot <-> agent + 3082 send 服务）
├── terminal-server/       # 3081 终端服务（node + node-pty + 词元/提问检测；backgrounds/ 终端背景图）
├── deploy.sh              # WSL 一键部署脚本
├── assets/                # 鲸鱼素材（四色 bin/ico + 托盘图标）
└── README.md
```

## WSL 部署（重要）

**前提**：Windows 10/11 + WSL2 + Ubuntu（`wsl --install`）；Windows 侧已装 WebView2（一般自带）。

**一键部署（在 WSL 内运行）**：

```bash
# 1. 克隆/拷贝本仓库到 WSL，进入目录
bash deploy.sh
```

脚本自动完成：装依赖 → 装 dsh → 配 DeepSeek API Key → 装终端服务 → 装插件 → 配置 systemd 服务自启（dsh-web + 终端服务）→ **自动重启 WSL**。

**部署完成后**：重新打开 WSL（服务已自启），Windows 侧双击 `dsh_client_full.exe` 即可使用——之后日常打开 WSL 就能用，无需再跑脚本。

> 如需手动启动（不重启 WSL）：`dsh --profile web` + `cd terminal-server && nohup node server.js &`

## 编译

依赖 Nim（2.x）+ MinGW-w64 + [nim-webui](https://github.com/webui-dev/nim-webui) + [winim](https://github.com/khchen/winim)：

```bat
nim c --app:gui -d:release --path:"<webui-nim路径>" --path:"<winim路径>" dsh_client_full.nim
```

编译要点：
- `--app:gui`：无终端窗口；先 `taskkill /F /IM dsh_client_full.exe` 再编译
- 蓝屏/异常中断后若报 `file not recognized`：删除 `nimcache/dsh_client_full_r` 重新编译
- 运行时需要 5 个 DLL（libgcc_s_seh-1 / libssp-0 / libstdc++-6 / libwinpthread-1 / WebView2Loader.dll）放 exe 同目录

## 使用说明

| 操作 | 效果 |
|---|---|
| 托盘左键 | 显示 / 最小化 主窗口 |
| 托盘右键 | 菜单（打开 / 显示或隐藏宠物 / 退出）|
| 悬浮鲸鱼左键 | 显示 / 最小化 主窗口 |
| 悬浮鲸鱼右键 | 同托盘菜单 |
| 页面右侧 `>_` 按钮 | 打开 / 收起 内嵌终端 |
| 终端面板 `⚙` | 背景色 / 透明度 / 字号 / 字体设置 |
| 窗口 ✕ | 弹回（保护机制），退出用托盘「退出」|
| 左缘横杠 | hover 展开大纲 / 点击跳转定位消息（黄闪 1.6s）|
| 右键上拖 | 滚到页顶 |
| 右键下拖 | 滚到底部 |
| 右键先上后下 | 刷新页面 |
| Ctrl+滚轮 / `+` / `-` / `0` | 缩放页面 / 恢复 100%（中央浮标显示百分比）|

## 版本历史

| 版本 | 内容 |
| v2.1.4（当前）| L 手势最小化（右键下→右 ±30°，事件驱动零延迟）；回复完成绿色常亮（不闪）；已归档会话面板（打开/恢复/删除）；界面字体设置（系统字库选择 + 字号下拉）；消息大纲随侧边栏宽度实时定位；exe 蓝色鲸鱼图标；微信 bot 修复（dsh 0.1.1-rc.2 会话持久化冲突导致不回消息） |
|---|---|
| v2.1.3 | 回复完成绿闪提示（提问后 dsh 干完活，悬浮鲸鱼/托盘/任务栏图标绿↔基态闪烁，主窗口置前即停）；基态色交换（打开=蓝、最小化=黑）；重启 dsh-web 后内嵌页面自动刷新（后端恢复检测 → navigate）；dsh-web.service 加 --no-open（不再自动弹系统浏览器）；Hub 平台 token 自动获取（从浏览器本地存储读取，token 失效自动恢复，无需手动 F12） |
| v2.1.2 | Bug 修复：①dsh 一键更新后仍显示旧版本（根因=server.js 用 require() 读 package.json 触发 Node 模块缓存，dsh-terminal 进程永远读到首次加载版本）→ 改 readLocalDshVersion() 用 fs.readFileSync+JSON.parse；②余额一直不显示（根因=.credentials.yaml 的 DEEPSEEK_API_KEY 在 refs: 嵌套下带缩进，正则 ^ 匹配不上）→ 改 ^\s*；余额刷新频率 2 分钟→30s（HUB 词元保持 10s 拉取/60s 聚合不变）；手动 sudo 重启 dsh-web 后前端轮询 /api/dsh-version 至 hasUpdate=false 且 3080 可访问时自动刷新页面（6 分钟超时） |
| v2.1.1 | Token HUD 增强：余额<5 元红色警示、「花费」行高峰/空闲状态（DeepSeek 峰谷定价官方规则 9:00-12:00/14:00-18:00，UTC+8）；dsh 版本更新提示（右下角一键更新，自动升级 npm 包 + 打开终端预输入 sudo 重启）；终端面板毛玻璃对齐 Token HUD；消息大纲拆分为独立 npm 插件 dsh-message-outline（v0.1.1 已上架） |
| v2.1.0 | 消息大纲独立插件（dsh-message-outline）、微信通道插件（dsh-wechat + 3082 send 服务）、微信会话归档隐藏；横杠大纲定稿（收起=视口 10 条窗口、行边界吸附）；README 整理 |
| v2.0.3 | 横杠大纲交互定稿：收起/展开对齐、激活消息蓝条跟随、鼠标手势（上/下/刷新）、缩放浮标 |
| v2.0.2 | 点✕=最小化（退出走托盘）、任务栏图标同步宠物色交替闪烁 |
| v2.0.1 | 图片背景、交替闪烁、终端状态服务端持久化 |
| v2.0.0 | 内嵌终端 + Token HUD + 三色宠物 + WSL 一键部署 |
| v1.0.0（GitHub Release）| 托盘 + 悬浮鲸鱼宠物 + 自动重建（闪退修复 v15）|

## 踩过的坑（给贡献者）

1. **窗口 15 秒自动关闭**：外部页面无 webui.js 连接 → 超时判"未连接"关窗，**必须 `setTimeout(0)`**。
2. **窗口异常消失/闪退**：对 webui 窗口的任何挂钩都会干扰初始化，**保持无挂钩** + 轮询重建。
3. **Nim `not` 是位取反**：`not IsWindowVisible(wnd)` 恒 true，**必须写 `== 0`**。
4. **窗口查找**：`FindWindowW` 偶发失配 → **EnumWindows + 进程过滤**。
5. **UTF-16 乱码**：托盘/菜单用 MultiByteToWideChar。
6. **内嵌终端不能用 iframe**：WebView2 iframe 透明背景不透出父页面；xterm 须用 **DOM 渲染器**（canvas 渲染器背景清不掉）。
7. **Nim 主循环禁 HTTP**：net 模块 send/recv 在 Windows 触发 0xc0000005 崩溃 → 状态用**本地文件**通信。
8. **前端事件通道是坑**：`subscribeEnvelopes` 是诊断通道收不到业务事件 → 词元/提问检测全部**后端聚合会话记录**。
9. **提问检测三坑**：`tool/result` 无工具名（按 callId 配对）；精确匹配 `"name":"ask_user_question"`（宽匹配误报）；dsh 重试机制（answer 集合 + 10 分钟时间窗）。

## 素材版权

悬浮鲸鱼与图标为 **DeepSeek 品牌形象**的二次创作（蓝/黑/橙三色，泡泡、白色肚皮等个性化改动），版权归 **DeepSeek** 所有，仅供个人学习使用。如 DeepSeek 官方要求，将立即移除相关素材。

## 许可证

[MIT](LICENSE) —— 代码部分。

> 注意：本仓库仅包含客户端代码、前端插件与终端服务，不包含 DeepSeek Harness 本体（后端由官方 `@deepseek-ai/dsh` 提供）。
