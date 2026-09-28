# DSH Nim 桌面客户端 (v2.2 浏览器化：winim 宠物壳)
# 功能: 悬浮鲸鱼(四色状态机) | 托盘 | 默认浏览器打开 3080 | 开机自启
# v2.2 架构(2026-09-06 拍板)：去掉 WebView2 独立窗口——对话界面改用默认
# 浏览器访问 127.0.0.1:3080(dsh web 本就是 web 应用)；壳层只留桌面鲸鱼+托盘
# (鲸鱼用途=提醒干活进度)。L 手势/窗口重建/token 交换等壳层逻辑全部移除。
import winim
import winim/inc/shellapi
import strutils, os, math, random

# winmm 高精度定时器（winim 未封装，手动声明；60fps 动画需要）
proc timeBeginPeriod(uPeriod: uint32): uint32 {.stdcall, dynlib: "winmm.dll", importc.}
proc timeEndPeriod(uPeriod: uint32): uint32 {.stdcall, dynlib: "winmm.dll", importc.}

# 调试日志（写到 exe 同目录，随程序移动；正常使用无感）
proc dbg(msg: string) =
  var f: File
  if open(f, getAppDir() & "\\dsh-client-debug.log", fmAppend):
    f.writeLine(msg)
    close(f)

const
  WebUrl = "http://127.0.0.1:3080"
  WebTokenFile = "dsh-web-token.txt"   # 认证引导 token 文件（exe 同目录；PWA/标签首次打开带 token 种 cookie）
  AppId = "dsh_nim_client"
  FLOAT_ANIM_MS = 12        # 悬浮动画帧间隔（2026-09-28 主定 80fps；12.5ms 不可整除，取 12ms≈83fps）
  # 托盘自定义消息
  WM_TRAYICON = WM_APP + 1
  ID_TRAY_OPENWEB = 1       # 打开 DSH（独立窗口/PWA）
  ID_TRAY_FULL = 2          # 切换：完整模式（复制指令）
  ID_TRAY_CLEAN = 3         # 切换：纯净模式（复制指令）
  ID_TRAY_PET = 4           # 显示/隐藏宠物开关
  ID_TRAY_EXIT = 5
  SingleMutexName = "DSH-Nim-Client-SingleInstance"   # 单实例互斥（重复点击 exe 不叠开）
  ActivateEventName = "DSH-Nim-Client-ActivateEvent"  # 新实例通知老实例"呼出主窗口"的事件

# ---- dsh web 认证引导（2026-09-05：dsh 0.1.2-rc.1 起 web 需浏览器认证）----
# 浏览器/WebView 首次必须带 token 访问一次：服务端校验通过后种下持久 cookie
# （默认 30 天），此后普通访问免认证。浏览器已各自完成认证；本壳只负责
# 拉起默认浏览器时带上 token（幂等：cookie 已有效时等于续期）。
# 用法：把 dsh web 启动时打印的完整 URL（含 ?token=，或只存 token 本身）
# 写入 exe 同目录 dsh-web-token.txt 后启动客户端。
proc launchToken(): string =
  let p = getAppDir() & "\\" & WebTokenFile
  try:
    if fileExists(p):
      let raw = strip(readFile(p))
      if raw.len > 0:
        let i = raw.find("?token=")
        result = if i >= 0: raw[(i + 7)..^1] else: raw
  except CatchableError:
    discard

proc bootUrl(): string =
  ## 认证引导 URL：token 文件有效时带 token，否则回落干净 WebUrl
  let t = launchToken()
  if t.len > 0: WebUrl & "?token=" & t else: WebUrl

var
  gTrayData: NOTIFYICONDATAW
  gRunning = true
  gQuitting = false
  gPetVisible = true        # 悬浮宠物显示状态（2026-08-16 定稿：默认打开；托盘开关控制）
  gFloatHwnd: HWND          # 悬浮宠物窗口句柄（托盘开关也要用）

# ---------- 全局句柄 ----------

var gHostHwnd: HWND         # 托盘宿主窗口（宠物右键菜单 owner，菜单 WM_COMMAND 由托盘处理）

# ---------- 托盘 ----------

proc loadWhaleIcon(size: int32, color: int = 0): HICON =
  ## 加载鲸鱼图标（0=蓝 1=黑 2=橙 3=绿；用提供的 deepseek-color-* 生成的四色 ico）
  const icoFiles = ["assets\\fish_blue.ico", "assets\\fish_black.ico",
                    "assets\\fish_orange.ico", "assets\\fish_green.ico"]
  let idx = if color >= 0 and color <= 3: color else: 0
  let icoPath = getAppDir() & "\\" & icoFiles[idx]
  result = LoadImageW(0, icoPath.cstring, IMAGE_ICON, size, size,
                      LR_LOADFROMFILE).HICON

proc setupTray(hwnd: HWND) =
  zeroMem(gTrayData.addr, sizeof(gTrayData))
  gTrayData.cbSize = DWORD(sizeof(NOTIFYICONDATAW))
  gTrayData.hWnd = hwnd
  gTrayData.uID = 1
  gTrayData.uFlags = NIF_MESSAGE or NIF_ICON or NIF_TIP
  gTrayData.uCallbackMessage = WM_TRAYICON
  let icon = loadWhaleIcon(32)
  gTrayData.hIcon = if icon != 0: icon else: LoadIconW(0, IDI_APPLICATION)
  # 托盘 tooltip：szTip 是 UTF-16(WCHAR) 数组，必须逐字符转换
  # （旧代码 copyMem 按字节拷 ASCII → 每 2 字节拼 1 个乱码字，实测托盘显示 8 个乱码）
  let tip = "DeepSeek Harness"
  for i in 0 ..< min(tip.len, 127):
    gTrayData.szTip[i] = WCHAR(tip[i])
  gTrayData.szTip[min(tip.len, 127)] = WCHAR(0)
  discard Shell_NotifyIconW(NIM_ADD, gTrayData.addr)

# ---- 菜单辅助：UTF-8 → UTF-16（AppendMenuW/ShellExecuteW 需要 LPCWSTR）----
proc toW(s: string): LPCWSTR =
  const CP_UTF8 = 65001
  var buf {.global.}: array[512, WCHAR]  # 静态缓冲（同步调用期间有效）
  let n = MultiByteToWideChar(CP_UTF8, 0, s.cstring, -1,
                              cast[LPWSTR](buf.addr), 512)
  if n > 0: cast[LPCWSTR](buf.addr) else: nil

proc toWs(s: string): wstring =
  ## 独立 GC 缓冲的 UTF-16 宽字符串（distinct string；避免 toW 的静态 buf 被多参数复用覆盖）
  const CP_UTF8 = 65001
  let wlen = MultiByteToWideChar(CP_UTF8, 0, s.cstring, -1, nil, 0)
  var buf = newString((wlen) * 2)
  discard MultiByteToWideChar(CP_UTF8, 0, s.cstring, -1,
                              cast[LPWSTR](addr buf[0]), wlen)
  result = wstring(buf)

proc openInBrowser() =
  ## v2.2 主入口：用系统默认浏览器打开 dsh web（127.0.0.1:3080）。
  ## 浏览器自身完成认证（cookie 已种则直接进）；带 token URL 幂等。
  let url = bootUrl()
  dbg("open browser: " & url)
  let wurl = toW(url)
  if wurl != nil:
    discard ShellExecuteW(0, nil, wurl, nil, nil, SW_SHOW)

proc openCmdDialog(cmd: string) =
  ## 弹出对话框：显示需用户在 bash 运行的指令，并自动复制到剪贴板方便一键粘贴。
  ## 用途：托盘一键切换纯净/完整 dsh 模式。因 dsh 在 WSL、切换需 sudo systemctl
  ## restart（sudo 无免密），exe 无法直接执行，改为"复制指令给用户去终端跑"。
  ## 复制指令到剪贴板（CF_UNICODETEXT）
  # 打开剪贴板：传宿主窗口 hwnd 提高成功率；失败重试一次（托盘点击瞬时占用常见）
  var clip = OpenClipboard(gHostHwnd)
  if clip == 0:
    sleep(50)
    clip = OpenClipboard(gHostHwnd)
  if clip == 0:
    let mFail = toWs("打开剪贴板失败，请手动复制下面指令到 WSL bash（遇到提权输入密码）：\n\n" & cmd)
    discard MessageBoxW(0, mFail, toWs("DSH 模式切换"), 0)
    return
  discard EmptyClipboard()
  let bytes = (cmd.len + 1) * sizeof(WCHAR)
  let hMem = GlobalAlloc(GMEM_MOVEABLE or GMEM_ZEROINIT, bytes)
  if cast[pointer](hMem) != nil:
    let p = cast[ptr UncheckedArray[WCHAR]](GlobalLock(hMem))
    if p != nil:
      # 复制 UTF-16 字节
      var i = 0
      for ch in cmd:
        let wc = ord(ch)
        p[i] = cast[WCHAR](wc)
        inc(i)
      p[cmd.len] = cast[WCHAR](0)
      discard GlobalUnlock(hMem)
      discard SetClipboardData(CF_UNICODETEXT, hMem)
    discard CloseClipboard()
  # MessageBox 显示指令（wstring 独立缓冲，converter 自动转 LPWSTR，避免 toW 静态缓冲覆盖）
  let mBody = toWs("已复制以下指令到剪贴板，请在 WSL bash 运行（遇到提权提示输入密码）：\n\n" & cmd)
  let mTitle = toWs("DSH 模式切换")
  discard MessageBoxW(0, mBody, mTitle, 0)

proc showTrayMenu(hwnd: HWND) =
  var hMenu = CreatePopupMenu()
  # v2.2：去掉「打开 DSH」菜单项（呼出/最小化走托盘左键与鲸鱼单击，菜单只留切换/宠物/退出）
  discard AppendMenuW(hMenu, MF_STRING, ID_TRAY_FULL, toW("切换：完整模式（复制指令）"))
  discard AppendMenuW(hMenu, MF_STRING, ID_TRAY_CLEAN, toW("切换：纯净模式（复制指令）"))
  discard AppendMenuW(hMenu, MF_SEPARATOR, 0, nil)
  if gPetVisible:
    discard AppendMenuW(hMenu, MF_STRING, ID_TRAY_PET, toW("隐藏宠物"))
  else:
    discard AppendMenuW(hMenu, MF_STRING, ID_TRAY_PET, toW("显示宠物"))
  discard AppendMenuW(hMenu, MF_SEPARATOR, 0, nil)
  discard AppendMenuW(hMenu, MF_STRING, ID_TRAY_EXIT, toW("退出"))
  var pt: POINT
  discard GetCursorPos(pt.addr)
  discard SetForegroundWindow(hwnd)
  discard TrackPopupMenu(hMenu, TPM_RIGHTBUTTON or TPM_LEFTALIGN,
                         pt.x, pt.y, 0, hwnd, nil)
  discard DestroyMenu(hMenu)

# ---------- dsh 对话窗口切换（v2.2.1：PWA 独立窗口/浏览器标签 呼出↔最小化） ----------
# term-panels 每 1.5s 把页面标题固定为 "DeepSeek Harness"（PWA 独立窗口与浏览器
# 标签的窗口标题都稳定为该值），本壳据此枚举找 dsh 对话窗口做切换。
var gFoundDshHwnd: HWND
var gFallbackDshHwnd: HWND    # 标题命中的非 PWA 窗口(浏览器标签等)，无 PWA 时兜底
var gOmniHit: bool            # 子窗口枚举是否发现地址栏控件
var gDshLaunchTick: int64 = 0  # 最近一次拉起 PWA 的时刻（防 2s 内重复点击重复开窗）
var gSingleMutex: HANDLE = 0  # 单实例互斥句柄（运行期保持，退出时释放）
var gActivateEvent: HANDLE = 0 # 激活事件句柄（新实例 SetEvent 触发本实例呼出）

proc omniWndProc(hwnd: HWND, lParam: LPARAM): WINBOOL {.stdcall.} =
  ## 递归枚举子窗口，找类名含 "omnibox" 的地址栏控件。
  var cls: array[128, WCHAR]
  let n = GetClassNameW(hwnd, cast[LPWSTR](cls.addr), 128)
  if n > 0:
    var s = newString(int(n))
    for i in 0 ..< int(n): s[i] = char(cls[i])
    if s.toLowerAscii().contains("omnibox"):
      gOmniHit = true
      return FALSE
  return TRUE

proc isPwaWindow(hwnd: HWND): bool =
  ## PWA 独立应用窗口没有地址栏；普通浏览器窗口有 Chrome_OmniboxView。
  ## 2026-09-10 用户需求：浏览器标签与 PWA 独立窗口标题同为 "DeepSeek Harness"，
  ## 靠地址栏有无把两者区分开，优先跟随 PWA（否则最小化 PWA 时鲸鱼不变黑）。
  gOmniHit = false
  discard EnumChildWindows(hwnd, omniWndProc, LPARAM(0))
  result = not gOmniHit

proc hasHarness(title: openArray[WCHAR], tn: int): bool =
  ## 大小写不敏感匹配品牌词 "harness"（纯净模式官方页面标题形如
  ## "deepseek harness -<会话>——deepseekharness" 全小写/连写；term-panels
  ## 固定版为 "DeepSeek Harness" 大写）。只匹配 dsh 页面，DeepSeek 官网不误命中。
  const marker = "harness"             # 7 字符全小写
  for i in 0 .. tn - 7:
    var m = true
    for j in 0 ..< 7:
      var ch = int(title[i + j])
      if ch > 127: m = false; break    # 非 ASCII 字符直接失败（防中文低位误匹配）
      if ch >= 65 and ch <= 90: ch += 32   # A-Z → a-z
      if ch != ord(marker[j]): m = false; break
    if m: return true
  return false

proc findDshWndProc(hwnd: HWND, lParam: LPARAM): WINBOOL {.stdcall.} =
  var title: array[256, WCHAR]
  let tn = GetWindowTextW(hwnd, cast[LPWSTR](title.addr), 256)
  if tn >= 7 and hasHarness(title, int(tn)):
    if isPwaWindow(hwnd):
      gFoundDshHwnd = hwnd        # 最高优先级：PWA 独立窗口，立即停止枚举
      return FALSE
    elif gFallbackDshHwnd == 0:
      gFallbackDshHwnd = hwnd     # 浏览器标签先记下，继续找有没有 PWA 窗口
  return TRUE

proc findDshWindow(): HWND =
  gFoundDshHwnd = 0
  gFallbackDshHwnd = 0
  discard EnumWindows(findDshWndProc, LPARAM(0))
  result = if gFoundDshHwnd != 0: gFoundDshHwnd else: gFallbackDshHwnd

proc findPwaShortcut(): string =
  ## 开始菜单递归找已安装的 PWA 快捷方式（文件名含 "DeepSeek Harness" 的 .lnk）。
  ## 路径动态化：扫 %APPDATA%/%ProgramData% 的 Start Menu\Programs，PWA 安装目录名
  ## 随浏览器而异（Cent Browser 应用/Edge 应用/Firefox Web 应用…），故不硬编码。
  const roots = [getEnv("APPDATA") & "\\Microsoft\\Windows\\Start Menu\\Programs",
                 getEnv("ProgramData") & "\\Microsoft\\Windows\\Start Menu\\Programs"]
  for root in roots:
    if root.len <= 10 or not dirExists(root): continue
    for kind, p in walkDir(root):          # 第一层（直接放 Programs 根）
      if kind == pcFile and p.toLowerAscii().endsWith(".lnk") and
         p.toLowerAscii().contains("deepseek harness"): return p
    for kind1, d in walkDir(root):         # 第二层（<浏览器名> 应用/ 目录内）
      if kind1 == pcDir:
        for kind2, p in walkDir(d):
          if kind2 == pcFile and p.toLowerAscii().endsWith(".lnk") and
             p.toLowerAscii().contains("deepseek harness"): return p
  return ""

proc toggleDshApp() =
  ## 点鲸鱼/托盘左键：对话窗口(PWA/浏览器标签)已开 → 呼出/最小化切换；
  ## 未开 → 优先拉起已安装 PWA 独立窗口(.lnk)，无 PWA → 回落默认浏览器打开 3080。
  let t0 = GetTickCount64()
  let wnd = findDshWindow()
  if wnd != 0:
    if IsIconic(wnd) == 1:                      # 最小化 → 呼出
      discard ShowWindow(wnd, SW_RESTORE)
      discard SetForegroundWindow(wnd)
      dbg("toggle: restore, find=" & $(GetTickCount64() - t0) & "ms")
    elif IsWindowVisible(wnd) == 0:             # 隐藏（异常）→ 显示
      discard ShowWindow(wnd, SW_SHOW)
      discard ShowWindow(wnd, SW_RESTORE)
      discard SetForegroundWindow(wnd)
      dbg("toggle: show-hidden, find=" & $(GetTickCount64() - t0) & "ms")
    else:                                       # 可见 → 最小化
      discard ShowWindow(wnd, SW_MINIMIZE)
      dbg("toggle: minimize, find=" & $(GetTickCount64() - t0) & "ms")
    return
  # 防重复开窗：刚拉起过 PWA(2s 内窗口可能还在冷启动) → 忽略本次点击
  let nowT = GetTickCount64()
  if nowT - gDshLaunchTick < 2000:
    dbg("toggle: launch cooldown (2s), skip")
    return
  let lnk = findPwaShortcut()                   # 无窗口 → 拉起 PWA
  if lnk.len > 0:
    gDshLaunchTick = nowT
    dbg("toggle: no window, find=" & $(nowT - t0) & "ms, launching PWA: " & lnk)
    let w = toW(lnk)
    if w != nil: discard ShellExecuteW(0, nil, w, nil, nil, SW_SHOW)
  else:
    dbg("toggle: no window, no PWA, open browser, find=" & $(GetTickCount64() - t0) & "ms")
    openInBrowser()                             # 未装 PWA → 回落默认浏览器

proc floatPaint(hwnd: HWND)  # 前向声明（托盘 wndProc 与 floatWndProc 都会调用）

# ---------- 宿主窗口过程（托盘） ----------

proc wndProc(hwnd: HWND, msg: UINT, wParam: WPARAM, lParam: LPARAM): LRESULT {.stdcall.} =
  case msg
  of WM_TRAYICON:
    if lParam == WM_LBUTTONUP or lParam == WM_LBUTTONDBLCLK:
      toggleDshApp()    # v2.2.1：左键托盘 = dsh 窗口呼出/最小化切换（PWA 优先）
    elif lParam == WM_RBUTTONUP:
      showTrayMenu(hwnd)
    result = 0
  of WM_COMMAND:
    case LOWORD(wParam)
    of ID_TRAY_OPENWEB:
      toggleDshApp()
      result = 0
    of ID_TRAY_FULL:
      openCmdDialog("sudo bash ~/deepseek-harness/nim-client/dsh-mode.sh full")
      result = 0
    of ID_TRAY_CLEAN:
      openCmdDialog("sudo bash ~/deepseek-harness/nim-client/dsh-mode.sh clean")
      result = 0
    of ID_TRAY_PET:
      # 显示/隐藏悬浮宠物（隐藏时停动画定时器省资源）
      gPetVisible = not gPetVisible
      if gPetVisible:
        discard SetTimer(gFloatHwnd, 1, FLOAT_ANIM_MS, nil)
        floatPaint(gFloatHwnd)
        discard ShowWindow(gFloatHwnd, SW_SHOWNOACTIVATE)
      else:
        discard KillTimer(gFloatHwnd, 1)
        discard ShowWindow(gFloatHwnd, SW_HIDE)
      result = 0
    of ID_TRAY_EXIT:
      # v2.2 用户需求：退出宠物时一并关闭 dsh 对话窗口(PWA)——投递 WM_CLOSE 后稍等
      # 其处理，再退出本进程。注：若命中窗口是含 dsh 页面的浏览器标签窗口也会被关。
      let dw = findDshWindow()
      if dw != 0:
        discard PostMessageW(dw, WM_CLOSE, 0, 0)
        sleep(400)
      gQuitting = true
      gRunning = false
      discard Shell_NotifyIconW(NIM_DELETE, gTrayData.addr)
      result = 0
    else:
      result = DefWindowProcW(hwnd, msg, wParam, lParam)
  of WM_CLOSE:
    result = DefWindowProcW(hwnd, msg, wParam, lParam)
  of WM_DESTROY:
    result = 0
  else:
    result = DefWindowProcW(hwnd, msg, wParam, lParam)

proc createHostWindow(): HWND =
  let hInstance = GetModuleHandleW(nil)
  var wc: WNDCLASSW
  wc.style = CS_HREDRAW or CS_VREDRAW
  wc.lpfnWndProc = wndProc
  wc.hInstance = hInstance
  wc.lpszClassName = "DSHNimClientHostW"
  discard RegisterClassW(wc.addr)
  result = CreateWindowExW(0, "DSHNimClientHostW", "DSH Host".cstring,
                           WS_OVERLAPPED, 0, 0, 0, 0,
                           HWND_MESSAGE, 0, hInstance, nil)

# ========== 桌面悬浮鲸鱼图标（v8：无圆，整窗透明，鲸鱼在放置位置周边游动） ==========
# 2026-08-15 新方案：不做圆形背景。窗口全透明，蓝白鲸鱼以窗口中心
# （= 图标放置位置）为原点，在 gFloatOrbitR(40px) 的小范围内绕圈游动。
# 可拖动；点击切换主窗口 弹出/最小化

const
  FLOAT_AREA = 150          # 鲸鱼游动半径（px，以图标放置位置为中心）
  FISH_DRAW = 80            # 鲸鱼显示尺寸（px）
  FLOAT_W = FLOAT_AREA * 2 + FISH_DRAW   # 窗口宽 = 游动范围 + 鲸鱼尺寸
  FLOAT_H = FLOAT_AREA * 2 + FISH_DRAW
  MAX_BUBBLES = 12          # 最多泡泡数
  FISH_BIN_W = FISH_DRAW    # 鲸鱼像素宽（fish_*.bin）
  FISH_BIN_H = FISH_DRAW    # 鲸鱼像素高
  # 四色鲸鱼（BGRA 预乘，提供 deepseek-color-{blue,black,Orange,green}.png 制作，80x80）
  FISH_BIN_BLUE = "assets\\fish_blue.bin"    # 窗口打开（默认，2026-08-21 定：打开=蓝）
  FISH_BIN_BLACK = "assets\\fish_black.bin"  # 窗口最小化（2026-08-21 定：最小化=黑）
  FISH_BIN_ORANGE = "assets\\fish_orange.bin" # 提问/要授权（心跳闪烁）
  FISH_BIN_GREEN = "assets\\fish_green.bin"  # 回复完成（绿↔基态心跳闪烁，2026-08-21 用户需求）

type
  Bubble = object
    x, y: float    # 位置
    r: float       # 半径
    speed: float   # 上升速度
    life: float    # 0~1 生命（1=刚生成，0=消失）
    active: bool

var
  gFloatDragging = false
  gFloatDragStart: POINT
  gFloatWinStart: POINT
  gFloatClicked = false
  gFloatAngle = 0.0         # 鲸鱼游动角度（小幅绕圈）
  gFloatOrbitR = 50.0       # 绕圈轨道半径（纵横均 50px）：2026-09-28 主定 120→50
  gLastAnimTick: int64 = 0  # 上一动画帧时间戳（ms；时间驱动，消除帧间隔漂移造成的抖动）
  gFishX = FLOAT_W / 2.0    # 鲸鱼当前位置（窗口内，初始=放置位置）
  gFishY = FLOAT_H / 2.0
  gMouseInside = false      # 鼠标是否在窗口内
  gMouseX = FLOAT_W / 2.0   # 鼠标位置（窗口内）
  gMouseY = FLOAT_H / 2.0
  gBubbleAccum = 0.0        # 泡泡生成累积（秒；事件驱动，每 200ms 一个）
  gBubbles: array[MAX_BUBBLES, Bubble]
  # ---- v7 像素级渲染（UpdateLayeredWindow，无品红） ----
  # 四色鲸鱼像素：[0]=蓝（窗口打开） [1]=黑（窗口最小化） [2]=橙（提问/授权） [3]=绿（回复完成）
  gFishPixels: array[4, array[FISH_BIN_W * FISH_BIN_H, uint32]]
  gFishPixelsLoaded = false
  gPetColor = 0             # 0=蓝 1=黑 2=橙 3=绿（主循环低频轮询 3081 驱动）
  gPetBaseColor = 0         # 基态色（v2.2.1：dsh 窗口可见=蓝0 / 最小化或未开=黑1）——提问闪烁交替用
  gPetBlinkOn = true        # 橙心跳闪烁相位（信号色/基态交替）
  gPetBlinkTick: int64 = 0  # 心跳计时
  gDshWinTick: int64 = 0    # dsh 窗口状态轮询计时（命中后 50ms 快查 / 未命中 1s 枚举）
  gDshHwnd: HWND = 0        # 命中的 dsh 对话窗口句柄缓存（避免反复全系统 EnumWindows）
  gDshMinimized = true      # dsh 对话窗口(PWA)收起态（最小化或未开；启动默认收起=黑）
  gPetPollTick: int64 = 0   # 宠物状态轮询计时（自适应间隔）
  gPetPollOk = false        # 上次轮询是否成功（成功 1s / 失败 5s 间隔）
  gAsking = false           # 是否正在提问/要授权（橙色心跳，来自状态文件）
  gDoneReply = false        # 回复是否完成（绿色常亮；停靠=exe 检测 PWA 窗口置前写 ack，旧版同语义）
  gPetDoneAt: int64 = 0     # 最近一次 green 的 doneAt（时间戳，写 ack 用）
  gPetDoneAcked = false     # 本次 green 是否已 ack（PWA 窗口置前=用户已看到回复 → 不再绿）
  gDibBits: ptr UncheckedArray[uint32]   # DIB 像素（96x96 BGRA 预乘）
  gMemDC: HDC

proc applyPetIconColor() =
  ## 托盘 + 任务栏图标同步为当前显示色（蓝0/黑1/橙2/绿3），并释放旧句柄防泄漏。
  ## 2026-08-16 验收要求：托盘/任务栏图标与悬浮宠物同色且同相位交替闪烁——
  ## 显示色相位与 floatPaint 完全一致：提问中(gPetColor==2)或回复完成(gPetColor==3)
  ## 且闪烁相位 OFF 时显示基态色(gPetBaseColor)，否则显示 gPetColor。每 400ms 由主循环闪烁分支调用。
  let dispColor = if gPetColor >= 2 and not gPetBlinkOn: gPetBaseColor else: gPetColor
  # 托盘（NIM_MODIFY 后 Shell 内部复制图标，旧句柄可安全 DestroyIcon）
  let tIcon = loadWhaleIcon(32, dispColor)
  if tIcon != 0:
    let oldT = gTrayData.hIcon
    gTrayData.hIcon = tIcon
    discard Shell_NotifyIconW(NIM_MODIFY, gTrayData.addr)
    if oldT != 0: discard DestroyIcon(oldT)
  # v2.2：无 WebView 主窗口，任务栏图标逻辑移除（托盘图标即唯一状态灯）

proc floatLoadFishBins() =
  ## 加载四色鲸鱼像素（0=蓝 1=黑 2=橙 3=绿；BGRA 预乘，小端）
  const files = [FISH_BIN_BLUE, FISH_BIN_BLACK, FISH_BIN_ORANGE, FISH_BIN_GREEN]
  var anyLoaded = false
  for i in 0 ..< 4:
    let path = getAppDir() & "\\" & files[i]
    var f: File
    if open(f, path):
      var raw: array[FISH_BIN_W * FISH_BIN_H * 4, uint8]
      let n = readBuffer(f, raw.addr, raw.len)
      if n == raw.len:
        copyMem(gFishPixels[i].addr, raw.addr, raw.len)  # BGRA 字节序 == uint32 小端
        anyLoaded = true
      close(f)
  gFishPixelsLoaded = anyLoaded
  if not anyLoaded:
    echo "[DSH-Nim] 警告: 鲸鱼像素加载失败（四色 bin 均缺失）"

proc floatInitDib() =
  ## 创建 32bpp DIB（自顶向下）+ 内存 DC，供 UpdateLayeredWindow 像素渲染
  var bmi: BITMAPINFO
  bmi.bmiHeader.biSize = DWORD(sizeof(BITMAPINFOHEADER))
  bmi.bmiHeader.biWidth = FLOAT_W
  bmi.bmiHeader.biHeight = -FLOAT_H   # 负值 = 自顶向下
  bmi.bmiHeader.biPlanes = 1
  bmi.bmiHeader.biBitCount = 32
  bmi.bmiHeader.biCompression = BI_RGB  # 0
  gMemDC = CreateCompatibleDC(0)
  let dib = CreateDIBSection(0, bmi.addr, DIB_RGB_COLORS, cast[ptr pointer](addr gDibBits), HANDLE(0), DWORD(0))
  discard SelectObject(gMemDC, dib)

proc floatSpawnBubble() =
  ## 在鲸鱼附近生成一个泡泡
  for i in 0 ..< MAX_BUBBLES:
    if not gBubbles[i].active:
      gBubbles[i].active = true
      # 起点从图标中心**左移 1/3 图标宽**（2026-09-28 主定：原先从正中冒出，看着像在流泪）
      gBubbles[i].x = gFishX - float(FISH_BIN_W div 3) + float(rand(14) - 7)
      gBubbles[i].y = gFishY + float(rand(8) - 4)
      gBubbles[i].r = 2.0 + float(rand(5)) / 2.0
      gBubbles[i].speed = 0.5 + float(rand(16)) / 10.0   # 0.5~2.0「帧速」随机（主定；更新时 ×dt×60 换算为秒速）
      gBubbles[i].life = 1.0
      break

proc floatUpdateBubbles(dt: float) =
  ## 更新泡泡：上升 + 消散（2026-09-28 改事件/时间驱动：按真实 dt 推进，与帧率无关）
  for i in 0 ..< MAX_BUBBLES:
    if gBubbles[i].active:
      gBubbles[i].y -= gBubbles[i].speed * dt * 60.0   # speed 以「60fps 帧速」为基准 → 换算秒速
      gBubbles[i].life -= dt / 0.2                     # 寿命 200ms（主定）
      if gBubbles[i].life <= 0:
        gBubbles[i].active = false

proc floatWndProc(hwnd: HWND, msg: UINT, wParam: WPARAM, lParam: LPARAM): LRESULT {.stdcall.} =
  case msg
  of WM_NCHITTEST:
    # v8: 透明像素鼠标穿透（HTTRANSPARENT），鲸鱼/泡泡像素可交互（HTCLIENT）
    # 避免 380x380 大透明窗口挡住桌面操作
    var wr: RECT
    if GetWindowRect(hwnd, wr.addr):
      let lx = int(LOWORD(lParam)) - wr.left
      let ly = int(HIWORD(lParam)) - wr.top
      if lx >= 0 and lx < FLOAT_W and ly >= 0 and ly < FLOAT_H and
         gDibBits != nil and ((gDibBits[ly * FLOAT_W + lx] shr 24) and 0xFF) > 0:
        result = 1        # HTCLIENT
      else:
        result = -1       # HTTRANSPARENT
    else:
      result = -1
  of WM_LBUTTONDOWN:
    gFloatDragging = true
    gFloatClicked = true
    discard SetCapture(hwnd)
    discard GetCursorPos(gFloatDragStart.addr)
    var r: RECT
    discard GetWindowRect(hwnd, r.addr)
    gFloatWinStart.x = r.left
    gFloatWinStart.y = r.top
    result = 0
  of WM_MOUSEMOVE:
    if gFloatDragging:
      var pt: POINT
      discard GetCursorPos(pt.addr)
      let dx = pt.x - gFloatDragStart.x
      let dy = pt.y - gFloatDragStart.y
      if abs(dx) > 5 or abs(dy) > 5:
        gFloatClicked = false
      discard SetWindowPos(hwnd, 0,
        gFloatWinStart.x + dx, gFloatWinStart.y + dy,
        0, 0, SWP_NOSIZE or SWP_NOZORDER)
    else:
      # 非拖动时：检测鼠标位置（鲸鱼跟随互动，窗口内任意位置）
      let mx = float(LOWORD(lParam))
      let my = float(HIWORD(lParam))
      gMouseX = mx
      gMouseY = my
      # 鼠标在窗口内即互动（窗口整体是鲸鱼活动区）
      gMouseInside = mx >= 0 and mx < FLOAT_W and my >= 0 and my < FLOAT_H
      # 启用 mouseleave 跟踪（需要 TRACKMOUSEEVENT）
      var tme: TTRACKMOUSEEVENT
      tme.cbSize = DWORD(sizeof(TTRACKMOUSEEVENT))
      tme.dwFlags = TME_LEAVE
      tme.hwndTrack = hwnd
      discard TrackMouseEvent(tme.addr)
    result = 0
  of WM_MOUSELEAVE:
    gMouseInside = false
    result = 0
  of WM_LBUTTONUP:
    if gFloatDragging:
      gFloatDragging = false
      discard ReleaseCapture()
      if gFloatClicked:
        toggleDshApp()    # v2.2.1：单击鲸鱼 = dsh 窗口呼出/最小化切换（原为独立窗口）
    result = 0
  of WM_RBUTTONUP:
    # 宠物右键 → 托盘同款菜单（v14 新增；owner 用托盘宿主窗口，
    # 菜单 WM_COMMAND 由托盘 wndProc 处理，否则按钮无功能）
    if gHostHwnd != 0:
      showTrayMenu(gHostHwnd)
    else:
      showTrayMenu(hwnd)
    result = 0
  of WM_TIMER:
    # ---- 动画帧 ----
    # 0. 实测帧间隔（时间驱动）：SetTimer 与主循环 sleep 各自 16ms，但两者相位会漂移，
    #    若仍按「每帧固定步进」推进，速度就时快时慢 → 视觉抖动。改为按真实 dt 推进。
    let nowTick = int64(GetTickCount64())
    var dt = float(nowTick - gLastAnimTick) / 1000.0
    gLastAnimTick = nowTick
    if dt <= 0.0 or dt > 0.25: dt = 0.016    # 首帧 / 异常（如休眠唤醒）保护
    # 1. 更新鲸鱼目标位置
    let cx = FLOAT_W / 2.0
    let cy = FLOAT_H / 2.0
    var targetX, targetY: float
    if gMouseInside:
      # 鼠标在圆内：鲸鱼游向鼠标（保持一点距离，不遮挡光标）
      let dx = gMouseX - cx
      let dy = gMouseY - cy
      let d = sqrt(dx*dx + dy*dy)
      if d > 12:
        targetX = gMouseX - dx / d * 12
        targetY = gMouseY - dy / d * 12
      else:
        targetX = gMouseX
        targetY = gMouseY
    else:
      # 默认小幅绕圈游动（2026-09-28 主定：横向 50 / 纵向 25）。吐泡泡、鼠标接近
      # 游向鼠标、拖动等其余动画保持不变。
      gFloatAngle += 0.6283 * dt              # 弧度/秒；2026-09-28 主定一圈 10 秒（2π/10 ≈ 0.6283）
      if gFloatAngle > 6.283185307:
        gFloatAngle = 0.0
      targetX = cx + gFloatOrbitR * cos(gFloatAngle)
      targetY = cy + gFloatOrbitR * sin(gFloatAngle)        # 纵横均 50px（主定）
    # 2. 平滑移动鲸鱼（按实际帧间隔推进，帧率波动不影响观感）
    let k = 1.0 - exp(-5.0 * dt)              # 2026-09-28 主定 λ=5.0（时间常数 0.2s；8.0 略紧、5.0 更柔和）
    gFishX += (targetX - gFishX) * k
    gFishY += (targetY - gFishY) * k
    # 3. 吐泡泡（2026-09-28 改事件/时间驱动：每 500ms 一个，与帧率无关）
    gBubbleAccum += dt
    if gBubbleAccum >= 0.5:
      gBubbleAccum -= 0.5
      floatSpawnBubble()
    floatUpdateBubbles(dt)
    # 4. 重绘（v7: UpdateLayeredWindow 不能从 WM_PAINT 调用，故在定时器里直接渲染）
    floatPaint(hwnd)
    result = 0
  of WM_ERASEBKGND:
    result = 1  # 不擦背景（分层窗口由 UpdateLayeredWindow 合成）
  of WM_PAINT:
    # 分层窗口：UpdateLayeredWindow 直接合成，WM_PAINT 只做空处理
    var ps: PAINTSTRUCT
    discard BeginPaint(hwnd, ps.addr)
    discard EndPaint(hwnd, ps.addr)
    result = 0
  else:
    result = DefWindowProcW(hwnd, msg, wParam, lParam)

proc floatPaint(hwnd: HWND) =
  ## v8 像素级渲染（UpdateLayeredWindow，无圆无品红）：
  ## 整窗透明，只画蓝白鲸鱼 + 泡泡
  if gDibBits == nil: return
  # 1. 全透明背景（zeroMem 快速清 0，替代逐像素循环）
  zeroMem(gDibBits, FLOAT_W * FLOAT_H * sizeof(uint32))
  # 2. 鲸鱼（over 合成，预乘；颜色按 gPetColor：0=蓝 1=黑 2=橙 3=绿）
  #    提问闪烁（橙）/回复完成闪烁（绿）时交替绘制"基态色"（打开=蓝 / 最小化=黑），
  #    即蓝↔橙/绿 或 黑↔橙/绿 交替（2026-08-16 定稿橙；2026-08-21 同法加绿、基态色交换）
  if gFishPixelsLoaded:
    let drawColor = if gPetColor >= 2 and not gPetBlinkOn: gPetBaseColor else: gPetColor
    let fx = int(gFishX + 0.5) - FISH_BIN_W div 2   # 四舍五入（原截断会放大亚像素抖动）
    let fy = int(gFishY + 0.5) - FISH_BIN_H div 2
    for wy in 0 ..< FISH_BIN_H:
      let ty = fy + wy
      if ty < 0 or ty >= FLOAT_H: continue
      for wx in 0 ..< FISH_BIN_W:
        let src = gFishPixels[drawColor][wy * FISH_BIN_W + wx]
        let sa = int((src shr 24) and 0xFF)
        if sa == 0: continue
        let tx = fx + wx
        if tx < 0 or tx >= FLOAT_W: continue
        let idx = ty * FLOAT_W + tx
        let dst = gDibBits[idx]
        let ia = 255 - sa
        # 分量显式转 int（uint32 * int 不自动转换）
        let sb = int(src and 0xFF)
        let sg = int((src shr 8) and 0xFF)
        let sr = int((src shr 16) and 0xFF)
        let db = int(dst and 0xFF)
        let dg = int((dst shr 8) and 0xFF)
        let dr = int((dst shr 16) and 0xFF)
        let da = int((dst shr 24) and 0xFF)
        let outB = sb + (db * ia div 255)
        let outG = sg + (dg * ia div 255)
        let outR = sr + (dr * ia div 255)
        let outA = sa + (da * ia div 255)
        gDibBits[idx] = uint32(outB) or (uint32(outG) shl 8) or
                        (uint32(outR) shl 16) or (uint32(outA) shl 24)
  # 3. 泡泡（浅蓝色实心小圆，盖在圆上）
  for i in 0 ..< MAX_BUBBLES:
    if gBubbles[i].active:
      let bx = int(gBubbles[i].x)
      let by = int(gBubbles[i].y)
      let br = int(gBubbles[i].r)
      let y0 = if by - br > 0: by - br else: 0
      let y1 = if by + br < FLOAT_H - 1: by + br else: FLOAT_H - 1
      let x0 = if bx - br > 0: bx - br else: 0
      let x1 = if bx + br < FLOAT_W - 1: bx + br else: FLOAT_W - 1
      for py in y0 .. y1:
        for px in x0 .. x1:
          let dx = float(px) + 0.5 - float(bx)
          let dy = float(py) + 0.5 - float(by)
          if sqrt(dx*dx + dy*dy) <= float(br):
            # RGB(140,200,255) 不透明，盖在圆/鲸鱼上
            gDibBits[py * FLOAT_W + px] = 0xFF'u32 or (200'u32 shl 8) or (140'u32 shl 16) or (255'u32 shl 24)
  # 4. UpdateLayeredWindow 合成到屏幕
  var blend: BLENDFUNCTION
  blend.BlendOp = 0          # AC_SRC_OVER
  blend.BlendFlags = 0
  blend.SourceConstantAlpha = 255
  blend.AlphaFormat = 1      # AC_SRC_ALPHA（每像素 alpha）
  var r: RECT
  if GetWindowRect(hwnd, r.addr):
    var ptDst: POINT
    ptDst.x = r.left
    ptDst.y = r.top
    var ptSrc: POINT
    ptSrc.x = 0
    ptSrc.y = 0
    var sz: SIZE
    sz.cx = FLOAT_W
    sz.cy = FLOAT_H
    discard UpdateLayeredWindow(hwnd, 0, ptDst.addr, sz.addr,
                                gMemDC, ptSrc.addr, 0, blend.addr, 2)  # ULW_ALPHA

proc floatCreateWindow(): HWND =
  let hInstance = GetModuleHandleW(nil)
  var wc: WNDCLASSW
  wc.style = CS_HREDRAW or CS_VREDRAW
  wc.lpfnWndProc = floatWndProc
  wc.hInstance = hInstance
  wc.hCursor = LoadCursorW(0, cast[LPCWSTR](IDC_HAND))
  wc.lpszClassName = "DSHFloatIconW"
  discard RegisterClassW(wc.addr)
  result = CreateWindowExW(
    WS_EX_LAYERED or WS_EX_TOPMOST or WS_EX_TOOLWINDOW,
    "DSHFloatIconW", "DSH Float".cstring,
    WS_POPUP,
    100, 100, FLOAT_W, FLOAT_H,
    0, 0, hInstance, nil)

proc floatInit() =
  gFloatHwnd = floatCreateWindow()
  dbg("floatCreateWindow hwnd=" & $gFloatHwnd)
  if gFloatHwnd != 0:
    # v7: 像素级渲染（UpdateLayeredWindow），不再用品红色键
    floatInitDib()
    dbg("floatInitDib bits=" & $(gDibBits != nil))
    floatLoadFishBins()
    dbg("floatLoadFishBins loaded=" & $gFishPixelsLoaded)
    # 初始化位置：屏幕**右下角**（2026-09-28 主定：原右上角会挡住 Token HUB）
    let sw = GetSystemMetrics(SM_CXSCREEN)
    let sh = GetSystemMetrics(SM_CYSCREEN)
    discard SetWindowPos(gFloatHwnd, HWND_TOPMOST,
                         sw - FLOAT_W - 40, sh - FLOAT_H - 80, 0, 0,
                         SWP_NOSIZE)
    # 初始化鲸鱼位置在圆心
    gFishX = FLOAT_W / 2.0
    gFishY = FLOAT_H / 2.0
    if gPetVisible:
      # 显示宠物（2026-08-16 定稿：默认打开，托盘可隐藏）
      discard SetTimer(gFloatHwnd, 1, FLOAT_ANIM_MS, nil)
      discard ShowWindow(gFloatHwnd, SW_SHOWNOACTIVATE)
      # 首次渲染（窗口显示后 UpdateLayeredWindow 才生效）
      floatPaint(gFloatHwnd)
    else:
      # 隐藏状态：不启动动画定时器，节省资源
      discard ShowWindow(gFloatHwnd, SW_HIDE)
    dbg("floatPaint done")
    echo "[DSH-Nim] 悬浮图标已就绪 (v7 像素渲染)"

# ---------- 开机自启 ----------

proc setupAutostart() =
  let exePath = getAppFilename().replace("/", "\\")
  let regKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Run"
  var hKey: HKEY
  if RegOpenKeyExW(HKEY_CURRENT_USER, regKey.cstring, 0, KEY_SET_VALUE, hKey.addr) == ERROR_SUCCESS:
    discard RegSetValueExW(hKey, "DSH-Nim-Client".cstring, 0, REG_SZ,
                           cast[LPCBYTE](exePath.cstring),
                           DWORD(exePath.len + 1) * 2)
    discard RegCloseKey(hKey)
    echo "[自启] 已注册开机自启: ", exePath

proc fetchPetState(): int =
  ## 读 Windows 侧本地状态文件（终端服务写入），返回 0=蓝 1=黑 2=橙 3=绿。
  ## 2026-08-16 崩溃修复：原 HTTP 轮询（net 模块 send/recv）在 Windows 触发
  ## 0xc0000005 访问冲突导致进程崩溃；改为读本地文件（纯文件 I/O，零网络）。
  ## 路径动态化（2026-08-16 定稿）：%USERPROFILE%\\pet-state.json——
  ## 服务端写 Windows 用户目录根，不再硬编码用户名，换机可部署。
  ## v2.2：绿色停靠 = 本壳检测 PWA 窗口被置前(用户看到)后写 pet-ack.json（server 转 blue），
  ## 与旧版"主窗口置前即停"同语义，纯净/完整模式都不依赖页面 JS。
  try:
    let body = readFile(getEnv("USERPROFILE") & "\\pet-state.json")
    if body.contains("\"pet\":\"blue\""): return 0
    if body.contains("\"pet\":\"black\""): return 1
    if body.contains("\"pet\":\"orange\""): return 2
    if body.contains("\"pet\":\"green\""):
      let m = body.find("\"doneAt\":")
      if m >= 0:
        var i = m + 9
        while i < body.len and body[i] in {'0'..'9'}: i.inc
        try: gPetDoneAt = parseInt(body[m+9 ..< i])
        except CatchableError: discard
      return 3
    return -1
  except CatchableError:
    return -1

proc writePetAck() =
  ## PWA 对话窗口被置前(=用户已看到回复) → 写回执文件 pet-ack.json（server 见
  ## ack.doneAt >= green.doneAt 转 blue）。2026-09-06 v2.2 恢复（旧版同机制；
  ## 不用 HTTP——Nim 主循环禁网络调用，Windows 下 net 模块会 0xc0000005）
  try:
    writeFile(getEnv("USERPROFILE") & "\\pet-ack.json",
              "{\"doneAt\":" & $gPetDoneAt & "}")
  except CatchableError:
    discard

# ---------- 主流程 ----------

when isMainModule:
  echo "[DSH-Nim] 启动中..."
  # 高精度定时器（60fps 动画需要，默认 15.6ms 粒度会卡）
  discard timeBeginPeriod(1)
  dbg("main start")
  discard SetProcessDPIAware()

  # ---- 单实例：已有实例在跑 → 通知它"呼出主窗口(PWA)"并退出本实例 ----
  # 重复双击 exe / 开机自启重叠都不会叠开多个宠物（2026-09-06 用户需求）
  gSingleMutex = CreateMutexW(nil, FALSE, newWideCString(SingleMutexName))
  if GetLastError() == ERROR_ALREADY_EXISTS:
    let hEv = CreateEventW(nil, FALSE, FALSE, newWideCString(ActivateEventName))
    if hEv != 0:
      discard SetEvent(hEv)      # 触发已有实例呼出主窗口
      discard CloseHandle(hEv)
    dbg("single instance exists -> activate & exit")
    quit(0)
  # 本实例为唯一实例：创建激活事件（auto-reset），主循环轮询接收"呼出"请求
  gActivateEvent = CreateEventW(nil, FALSE, FALSE, newWideCString(ActivateEventName))

  setupAutostart()
  dbg("autostart ok")

  # 创建宿主窗口（托盘载体）
  gHostHwnd = createHostWindow()
  dbg("host hwnd=" & $gHostHwnd)
  if gHostHwnd != 0:
    setupTray(gHostHwnd)
    echo "[DSH-Nim] 托盘已就绪"
    dbg("tray ok")

  # 悬浮鲸鱼（v2.2：无 WebView 主窗口，直接初始化宠物壳）
  dbg("before floatInit")
  floatInit()
  dbg("after floatInit")

  # v2.2 用户需求：启动即自动拉起 PWA 对话窗口（出现鲸鱼 + 打开对话，等效旧版开机开窗；
  # 窗口已在则不重复开）。无 PWA 回落默认浏览器打开 3080。
  # 注：v2.2.2 曾加「启动自唤醒 WSL + 等待就绪」，经主实测判定鸡肋（唤醒与
  # wsl-autostart.vbs 重复、等待期用户一点开就失效），2026-09-28 按主决定**整段移除**；
  # WSL 与三服务由 HKCU Run 的 wsl-autostart.vbs + WSL 内 systemd 负责拉起。
  toggleDshApp()

  # 主循环：Win32 消息泵（托盘/宠物）+ 宠物状态轮询（纯文件 I/O，零网络）
  var msg: MSG
  while gRunning:
    while PeekMessageW(msg.addr, 0, 0, 0, PM_REMOVE):
      discard TranslateMessage(msg.addr)
      discard DispatchMessageW(msg.addr)

    # 单实例激活：重复点击 exe（新实例已退出）→ 本实例呼出 PWA 主窗口
    if gActivateEvent != 0 and WaitForSingleObject(gActivateEvent, 0) == WAIT_OBJECT_0:
      dbg("single-instance activate -> toggle dsh app")
      toggleDshApp()

    # 鼠标交互：鲸鱼游向鼠标（GetCursorPos 轮询，透明穿透区也感知）
    if not gFloatDragging:
      var mpt: POINT
      if GetCursorPos(mpt.addr):
        var wr: RECT
        if GetWindowRect(gFloatHwnd, wr.addr):
          let lx = float(mpt.x - wr.left)
          let ly = float(mpt.y - wr.top)
          let mdx = lx - FLOAT_W / 2.0
          let mdy = ly - FLOAT_H / 2.0
          if sqrt(mdx*mdx + mdy*mdy) <= float(FLOAT_AREA):
            gMouseInside = true
            gMouseX = lx
            gMouseY = ly
          else:
            gMouseInside = false
    else:
      gMouseInside = false  # 拖动时不跟随

    # ---- dsh 窗口状态：即时跟随基态色（v2.2.1 用户需求，同旧独立窗口感知）----
    # 命中窗口后 50ms 单窗口快查（IsWindow/IsIconic 廉价调用，零枚举 → 即时变色，
    # 等效旧版每帧跟随）；窗口未命中(未开/被关)时 1s 低频 EnumWindows 重新找。
    let petTick = GetTickCount64()
    if gDshHwnd == 0:
      if petTick - gDshWinTick >= 1000:
        gDshWinTick = petTick
        gDshHwnd = findDshWindow()
        gDshMinimized = if gDshHwnd != 0: IsIconic(gDshHwnd) == 1 else: true
    else:
      if petTick - gDshWinTick >= 50:
        gDshWinTick = petTick
        if IsWindow(gDshHwnd) == 0:
          gDshHwnd = 0          # PWA 窗口被关 → 回未命中分支（收起态 + 1s 后重找）
          gDshMinimized = true
        else:
          gDshMinimized = IsIconic(gDshHwnd) == 1
    # ---- 宠物颜色：提问(橙,文件) > 回复完成(绿,文件) > 基态(窗口可见=蓝/收起=黑) ----
    let pollGap = if gPetPollOk: 1000 else: 5000   # 失败拉长间隔，少打扰主循环
    if petTick - gPetPollTick > pollGap:
      gPetPollTick = petTick
      let prevDoneAt = gPetDoneAt
      let c = fetchPetState()
      gPetPollOk = c >= 0
      gAsking = c == 2
      gDoneReply = c == 3
      if c == 3 and gPetDoneAt != prevDoneAt:
        gPetDoneAcked = false     # 新一轮回复完成 → 重新需要提示
      if c != 3:
        gPetDoneAcked = false
    # 绿色保持（旧版同语义）：PWA 对话窗口被置前(GetForegroundWindow==命中窗口、
    # 非最小化) = 用户已看到回复 → 写 ack → server 转 blue 停绿。
    # 点鲸鱼呼出窗口后窗口变前台即触发；点成最小化则窗口非前台保持绿(提示仍在)。
    if gDoneReply and not gPetDoneAcked and gDshHwnd != 0 and
       GetForegroundWindow() == gDshHwnd and IsIconic(gDshHwnd) == 0:
      gPetDoneAcked = true
      writePetAck()
      gDoneReply = false
      dbg("pet green acked (PWA foreground)")
    gPetBaseColor = if gDshMinimized: 1 else: 0   # 黑(收起) / 蓝(可见)
    var target = 0
    if gAsking:
      target = 2
    elif gDoneReply:
      target = 3
    elif gDshMinimized:
      target = 1
    else:
      target = 0
    if target != gPetColor:
      gPetColor = target
      gPetBlinkOn = true
      floatPaint(gFloatHwnd)
      applyPetIconColor()   # 托盘图标跟随宠物色（蓝/黑/橙/绿）
      dbg("pet color -> " & $target)
    # 提问(橙)心跳闪烁；回复完成(绿)常亮不闪（2026-08-27 用户需求：绿不闪）
    if gPetColor == 2 and petTick - gPetBlinkTick >= 400:
      gPetBlinkTick = petTick
      gPetBlinkOn = not gPetBlinkOn
      floatPaint(gFloatHwnd)
      applyPetIconColor()

    sleep(FLOAT_ANIM_MS)
