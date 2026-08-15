# DSH Pet Client

DeepSeek Harness 的 Windows 桌面客户端——带托盘与悬浮鲸鱼宠物的 WebView2 外壳。

用 **Nim + webui + winim** 实现，双击运行即打开嵌入 WebView2 的 DSH 窗口。

## 亮点

| 指标 | 数值 |
|---|---|
| exe 体积 | ~900 KB |
| 内存占用 | ~27 MB |
| 启动 | 秒开（WebView2 初始化除外）|
| 渲染内核 | WebView2（Windows 自带，无需打包浏览器）|

对比：Electron 版约 269MB / ~200MB 内存。

## 功能

- 🐳 悬浮鲸鱼宠物（默认隐藏，托盘可开启；60fps 游动动画 + 泡泡 + 鼠标跟随 + 拖动）
- 🖥️ 托盘图标（左键 显示/最小化，右键 菜单：打开/重新加载/宠物/退出）
- 🪟 WebView2 嵌入窗口，加载 `http://127.0.0.1:3080`（dsh web 默认端口，开箱即用）
- 🔄 窗口异常消失自动重建；后端断连（WSL 重启/dsh web 重启）自动恢复
- 📌 窗口标题固定为 `DeepSeek Harness`（不受页面会话标题影响）
- 💾 窗口尺寸记忆（注册表 `Software\Bikini\DSH-Nim-Client`）
- 🔑 开机自启（HKCU Run 键，可选）

## 依赖

| 依赖 | 说明 |
|---|---|
| [dsh](https://github.com/deepseek-ai/deepseek-harness) | 后端 web 服务（`dsh --profile web`，默认 3080 端口） |
| [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) | Windows 10/11 一般自带 |
| Nim + MinGW | 仅编译需要，运行不需要 |

## 快速开始

```bash
# 1. 启动 dsh web（需 Node.js，Windows 原生或 WSL 均可）
npm install -g @deepseek-ai/dsh
dsh --profile web

# 2. 运行客户端（Windows）
dsh_client_full.exe
```

## 编译

依赖 Nim（2.x）+ MinGW-w64 + [nim-webui](https://github.com/webui-dev/nim-webui) + [winim](https://github.com/khchen/winim)：

```bat
nim c --app:gui -d:release --path:"<webui-nim路径>" --path:"<winim路径>" dsh_client_full.nim
```

编译要点：
- `--app:gui`：无终端窗口
- 先 `taskkill /F /IM dsh_client_full.exe` 再编译（exe 被占用会链接失败）
- 蓝屏/异常中断后若报 `file not recognized`：删除 `nimcache/dsh_client_full_r` 重新编译
- 运行时需要 5 个 DLL（libgcc_s_seh-1 / libssp-0 / libstdc++-6 / libwinpthread-1 / WebView2Loader.dll）放 exe 同目录

## 使用说明

| 操作 | 效果 |
|---|---|
| 托盘左键 | 显示 / 最小化 主窗口 |
| 托盘右键 | 菜单（打开 / 重新加载 / 显示宠物 / 退出）|
| 悬浮鲸鱼左键 | 显示 / 最小化 主窗口 |
| 悬浮鲸鱼右键 | 同托盘菜单 |
| 窗口 ✕ | 弹回（保护机制），退出用托盘「退出」|

## 踩过的坑（给贡献者）

1. **窗口 15 秒自动关闭**：webui 默认 `startup_timeout=15s`，外部页面无 webui.js 连接 → 超时判"未连接"关窗。**必须 `setTimeout(0)`**。
2. **窗口异常消失/闪退**：对 webui 窗口的任何挂钩（subclass、close handler）都会干扰初始化导致窗口异常。**保持无挂钩**，用轮询检测 + 自动重建。
3. **最小化失效（点击闪一下）**：**Nim 的 `not` 对整数是位取反**——`not IsWindowVisible(wnd)` 中 `not 1 = -2`（非零恒 true）→ 可见窗口永远误走"显示"分支。**必须写 `IsWindowVisible(wnd) == 0`**。
4. **窗口查找**：`FindWindowW` 对 webui 类名（A/W 注册差异）偶发失配、标题匹配会误中浏览器窗口 → **用 EnumWindows 遍历 + 进程过滤**（GetWindowThreadProcessId == 本进程）。
5. **托盘/菜单乱码**：`szTip`/菜单项是 UTF-16（WCHAR）数组，不能按字节拷 ASCII，需 MultiByteToWideChar 转换。
6. **窗口标题被页面覆盖**：dsh web 前端把会话标题拼进 `document.title` → 客户端每 5 秒强制 `SetWindowTextW` 为固定标题。
7. **悬浮图标初始化顺序**：主窗口 `showWv` 之后再 `floatInit()`，否则 webui 窗口受影响。
8. **宠物右键菜单按钮无响应**：菜单 owner 必须用托盘宿主窗口（否则 WM_COMMAND 无人处理）。

## 素材版权

悬浮鲸鱼与图标为 **DeepSeek 品牌形象**的二次创作（泡泡、白色肚皮等个性化改动），版权归 **DeepSeek** 所有，仅供个人学习使用。如 DeepSeek 官方要求，将立即移除相关素材。

## 许可证

[MIT](LICENSE) —— 代码部分。

> 注意：本仓库仅包含客户端代码与素材，不包含 DeepSeek Harness 本体（后端由官方 `@deepseek-ai/dsh` 提供）。
