# DSH Nim 桌面客户端 (webui + winim 完整版)
# 功能: 加载 3080 | 鲸鱼图标 | 托盘 | 悬浮图标 | 开机自启 | 尺寸记忆 | 三色宠物状态机
import webui
from webui/bindings import minimize
import winim
import winim/inc/shellapi
import strutils, os, math, random, net

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
  AppId = "dsh_nim_client"
  FLOAT_ANIM_MS = 16        # 悬浮动画帧间隔（60fps 定稿；主实测 60fps 开宠物稳定——降频无关，
                            # 稳定关键是无窗口挂钩，见主循环注释）
  # 托盘自定义消息
  WM_TRAYICON = WM_APP + 1
  ID_TRAY_OPEN = 1
  ID_TRAY_EXIT = 3
  ID_TRAY_PET = 4          # 显示/隐藏宠物开关

var
  gWindow: Window
  gTrayData: NOTIFYICONDATAW
  gRunning = true
  gQuitting = false
  gLastW = 0
  gLastH = 0
  gCloseCount = 0
  gBackendDown = false      # 后端断连标志（后端不可达时停止重建尝试，等恢复）
  gLastRetryTime: int64     # 上次窗口重建尝试时间（限频，GetTickCount64 返回 int64）
  gLastTitleCheck: int64    # 上次标题强制检查时间
  gWindowMinimized = false  # 自己跟踪窗口状态，不依赖 IsIconic
  gPetVisible = true        # 悬浮宠物显示状态（2026-08-16 主定稿：默认打开；托盘开关控制）
  gFloatHwnd: HWND          # 悬浮宠物窗口句柄（托盘开关也要用）

# ---------- 主窗口控制 ----------

var gMainFoundHwnd: HWND    # EnumWindows 回调结果缓存（标题命中 = 主窗口）
var gMainCandidateHwnd: HWND  # 类名候选兜底（WebView* 首个命中，仅无标题命中时用）
var gHostHwnd: HWND         # 托盘宿主窗口（宠物右键菜单 owner，菜单 WM_COMMAND 由托盘处理）

proc enumMainWndProc(hwnd: HWND, lParam: LPARAM): WINBOOL {.stdcall.} =
  ## EnumWindows 回调：找本进程的 webui 主窗口。
  ## 2026-08-16 改为「标题优先」：主窗口标题恒为 "DeepSeek Harness"（forceMainWindowTitle
  ## 每 5 秒强制），终端窗口（第二 WebView2 窗口）页面标题是 "DSH Terminal"——
  ## 终端窗口类名同为 WebView*，若类名优先会被误判为主窗口（标题强制/尺寸记忆/消失
  ## 重建全作用到终端窗口上）。故类名 WebView* 只作候选兜底，标题命中才立即返回。
  ## 必须按进程过滤：浏览器等外部窗口标题可能与 dsh 页面相同（"DeepSeek Harness"），
  ## 不排除会误匹配（实测：点击托盘拉起浏览器）
  var wndPid: DWORD
  discard GetWindowThreadProcessId(hwnd, wndPid.addr)
  if wndPid != GetCurrentProcessId():
    return TRUE
  var title: array[256, WCHAR]
  let tn = GetWindowTextW(hwnd, cast[LPWSTR](title.addr), 256)
  if tn > 0:
    const marker = "DeepSeek Harness"
    for i in 0 ..< tn:
      if tn - i >= 16:
        var m = true
        for j in 0 ..< 16:
          if title[i + j] != WCHAR(marker[j]):
            m = false
            break
        if m:
          gMainFoundHwnd = hwnd
          return FALSE
  var cls: array[64, WCHAR]
  let cn = GetClassNameW(hwnd, cast[LPWSTR](cls.addr), 64)
  if cn > 0:
    const prefix = "WebView"
    var match = cn >= 7
    for i in 0 ..< 7:
      if cls[i] != WCHAR(prefix[i]):
        match = false
        break
    if match and gMainCandidateHwnd == 0:
      gMainCandidateHwnd = hwnd
  return TRUE

proc findMainWindow(): HWND =
  ## 查找主窗口：EnumWindows 遍历，标题含 "DeepSeek Harness" 优先命中，
  ## 类名 WebView* 候选兜底（无标题命中时用；第二 WebView2 窗口不受影响）
  ## 比 FindWindow 可靠：webui 类名 A/W 注册差异 + 页面标题动态变化都会让
  ## FindWindow 精确匹配失配（实测 FindWindowW("WebViewWindow") 偶发失败）
  gMainFoundHwnd = 0
  gMainCandidateHwnd = 0
  discard EnumWindows(enumMainWndProc, LPARAM(0))
  if gMainFoundHwnd != 0:
    return gMainFoundHwnd
  if gMainCandidateHwnd != 0:
    return gMainCandidateHwnd
  return FindWindowW(nil, "DeepSeek Harness".cstring)

proc forceMainWindowTitle() =
  ## 强制主窗口标题为 "DeepSeek Harness"（dsh web 前端会把会话标题拼进页面
  ## title，窗口标题跟随变化；主要求固定标题）
  let mw = findMainWindow()
  if mw != 0:
    var t: array[64, WCHAR]
    let tn = GetWindowTextW(mw, cast[LPWSTR](t.addr), 64)
    if tn != 16:
      var buf: array[64, WCHAR]
      let tip = "DeepSeek Harness"
      for i in 0 ..< tip.len:
        buf[i] = WCHAR(tip[i])
      buf[tip.len] = WCHAR(0)
      discard SetWindowTextW(mw, cast[LPCWSTR](buf.addr))
      dbg("title forced to DeepSeek Harness")

proc restoreMainWindow() =
  ## 恢复/显示主窗口
  let wnd = findMainWindow()
  if wnd != 0:
    discard ShowWindow(wnd, SW_SHOW)
    discard ShowWindow(wnd, SW_RESTORE)
    discard SetForegroundWindow(wnd)

proc toggleMainWindow() =
  ## 切换主窗口 显示/最小化（托盘和悬浮图标共用）
  ## 2026-08-15 修复：实时读 IsIconic/IsWindowVisible，不依赖缓存状态——
  ## 任务栏点击（Windows 默认处理）与托盘点击混合时，缓存状态会与实际脱节
  ## （实测：点几次后窗口最小化弹不出）。
  let wnd = findMainWindow()
  if wnd != 0:
    if IsIconic(wnd) == 1:
      # 当前最小化 → 恢复
      gWindowMinimized = false
      discard ShowWindow(wnd, SW_RESTORE)
      discard SetForegroundWindow(wnd)
    elif IsWindowVisible(wnd) == 0:
      # 当前不可见但非最小化（异常）→ 显示
      # 注意：不能用 not IsWindowVisible(wnd)——Nim 的 not 对整数是位取反，
      # not 1 = -2（非零为 true）导致可见窗口也走此分支（实测"闪一下不最小化"）
      gWindowMinimized = false
      discard ShowWindow(wnd, SW_SHOW)
      discard ShowWindow(wnd, SW_RESTORE)
      discard SetForegroundWindow(wnd)
    else:
      # 当前可见 → 最小化（用 webui 官方 API，走库内部保存的 hwnd）
      gWindowMinimized = true
      minimize(csize_t(gWindow))
      # 兜底：若 webui API 未生效，再直接 ShowWindow
      if IsIconic(wnd) != 1:
        discard ShowWindow(wnd, SW_MINIMIZE)
  else:
    # 窗口不存在（被销毁）→ 重建（v10：任何场景都不让窗口消失变成"程序消失"）
    dbg("toggle -> window missing, re-show")
    gWindow.setSize(gLastW, gLastH)
    discard gWindow.showWv(WebUrl)

proc showMainWindowIfMissing() =
  ## 托盘"打开 DSH"：窗口存在则恢复显示，不存在则重建
  let wnd = findMainWindow()
  if wnd != 0:
    restoreMainWindow()
  else:
    dbg("tray open -> re-show window")
    gWindow.setSize(gLastW, gLastH)
    discard gWindow.showWv(WebUrl)

# ---------- 托盘 ----------

proc loadWhaleIcon(size: int32, color: int = 0): HICON =
  ## 加载鲸鱼图标（0=蓝 1=黑 2=橙；用主提供的 deepseek-color-* 生成的三色 ico）
  const icoFiles = ["assets\\fish_blue.ico", "assets\\fish_black.ico", "assets\\fish_orange.ico"]
  let idx = if color >= 0 and color <= 2: color else: 0
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

proc showTrayMenu(hwnd: HWND) =
  # 菜单项转 UTF-16（AppendMenuW 需要 LPCWSTR；UTF-8 直传会乱码）
  const CP_UTF8 = 65001
  proc w(s: string): LPCWSTR =
    var buf {.global.}: array[256, WCHAR]  # 静态缓冲（菜单同步显示期间有效）
    let n = MultiByteToWideChar(CP_UTF8, 0, s.cstring, -1,
                                cast[LPWSTR](buf.addr), 256)
    if n > 0: cast[LPCWSTR](buf.addr) else: nil
  var hMenu = CreatePopupMenu()
  discard AppendMenuW(hMenu, MF_STRING, ID_TRAY_OPEN, w("打开 DSH"))
  if gPetVisible:
    discard AppendMenuW(hMenu, MF_STRING, ID_TRAY_PET, w("隐藏宠物"))
  else:
    discard AppendMenuW(hMenu, MF_STRING, ID_TRAY_PET, w("显示宠物"))
  discard AppendMenuW(hMenu, MF_SEPARATOR, 0, nil)
  discard AppendMenuW(hMenu, MF_STRING, ID_TRAY_EXIT, w("退出"))
  var pt: POINT
  discard GetCursorPos(pt.addr)
  discard SetForegroundWindow(hwnd)
  discard TrackPopupMenu(hMenu, TPM_RIGHTBUTTON or TPM_LEFTALIGN,
                         pt.x, pt.y, 0, hwnd, nil)
  discard DestroyMenu(hMenu)

proc floatPaint(hwnd: HWND)  # 前向声明（托盘 wndProc 与 floatWndProc 都会调用）

# ---------- 宿主窗口过程（托盘） ----------

proc wndProc(hwnd: HWND, msg: UINT, wParam: WPARAM, lParam: LPARAM): LRESULT {.stdcall.} =
  case msg
  of WM_TRAYICON:
    if lParam == WM_LBUTTONUP or lParam == WM_LBUTTONDBLCLK:
      toggleMainWindow()
    elif lParam == WM_RBUTTONUP:
      showTrayMenu(hwnd)
    result = 0
  of WM_COMMAND:
    case LOWORD(wParam)
    of ID_TRAY_OPEN:
      showMainWindowIfMissing()
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
      gQuitting = true
      gRunning = false
      discard Shell_NotifyIconW(NIM_DELETE, gTrayData.addr)
      webui.exit()
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
# （= 图标放置位置）为原点，在 FLOAT_AREA(150px) 半径内绕圈游动。
# 可拖动；点击切换主窗口 弹出/最小化

const
  FLOAT_AREA = 150          # 鲸鱼游动半径（px，以图标放置位置为中心）
  FISH_DRAW = 80            # 鲸鱼显示尺寸（px）
  FLOAT_W = FLOAT_AREA * 2 + FISH_DRAW   # 窗口宽 = 游动范围 + 鲸鱼尺寸
  FLOAT_H = FLOAT_AREA * 2 + FISH_DRAW
  MAX_BUBBLES = 12          # 最多泡泡数
  FISH_BIN_W = FISH_DRAW    # 鲸鱼像素宽（fish_*.bin）
  FISH_BIN_H = FISH_DRAW    # 鲸鱼像素高
  # 三色鲸鱼（BGRA 预乘，主提供 deepseek-color-{blue,black,Orange}.png 制作，80x80）
  FISH_BIN_BLUE = "assets\\fish_blue.bin"    # 终端收起（默认）
  FISH_BIN_BLACK = "assets\\fish_black.bin"  # 终端打开
  FISH_BIN_ORANGE = "assets\\fish_orange.bin" # 提问/要授权（心跳闪烁）

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
  gFloatAngle = 0.0         # 鲸鱼游动角度
  gFloatOrbitR = 120.0      # 绕圈轨道半径（FLOAT_AREA 内留边距）
  gFishX = FLOAT_W / 2.0    # 鲸鱼当前位置（窗口内，初始=放置位置）
  gFishY = FLOAT_H / 2.0
  gMouseInside = false      # 鼠标是否在窗口内
  gMouseX = FLOAT_W / 2.0   # 鼠标位置（窗口内）
  gMouseY = FLOAT_H / 2.0
  gBubbleTimer = 0          # 泡泡生成计时
  gBubbles: array[MAX_BUBBLES, Bubble]
  # ---- v7 像素级渲染（UpdateLayeredWindow，无品红） ----
  # 三色鲸鱼像素：[0]=蓝（终端收起） [1]=黑（终端打开） [2]=橙（提问/授权）
  gFishPixels: array[3, array[FISH_BIN_W * FISH_BIN_H, uint32]]
  gFishPixelsLoaded = false
  gPetColor = 0             # 0=蓝 1=黑 2=橙（主循环低频轮询 3081 驱动）
  gPetBaseColor = 0         # 基态色（非提问时颜色：最小化=蓝 0，打开=黑 1）——提问闪烁交替用
  gPetBlinkOn = true        # 橙色心跳闪烁相位（橙/基态交替）
  gPetBlinkTick: int64 = 0  # 心跳计时
  gPetPollTick: int64 = 0   # 宠物状态轮询计时（自适应间隔）
  gPetPollOk = false        # 上次轮询是否成功（成功 1s / 失败 5s 间隔）
  gAsking = false           # 是否正在提问/要授权（橙色心跳，来自状态文件）
  gDibBits: ptr UncheckedArray[uint32]   # DIB 像素（96x96 BGRA 预乘）
  gMemDC: HDC

proc floatLoadFishBins() =
  ## 加载三色鲸鱼像素（0=蓝 1=黑 2=橙；BGRA 预乘，小端）
  const files = [FISH_BIN_BLUE, FISH_BIN_BLACK, FISH_BIN_ORANGE]
  var anyLoaded = false
  for i in 0 ..< 3:
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
    echo "[DSH-Nim] 警告: 鲸鱼像素加载失败（三色 bin 均缺失）"

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
      gBubbles[i].x = gFishX + float(rand(14) - 7)
      gBubbles[i].y = gFishY + float(rand(8) - 4)
      gBubbles[i].r = 2.0 + float(rand(5)) / 2.0
      gBubbles[i].speed = 0.8 + float(rand(5)) / 3.0
      gBubbles[i].life = 1.0
      break

proc floatUpdateBubbles() =
  ## 更新泡泡：上升 + 消散
  for i in 0 ..< MAX_BUBBLES:
    if gBubbles[i].active:
      gBubbles[i].y -= gBubbles[i].speed
      gBubbles[i].life -= 0.03
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
        toggleMainWindow()
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
      # 默认绕圈游动
      gFloatAngle += 0.015
      if gFloatAngle > 6.283185307:
        gFloatAngle = 0.0
      targetX = cx + gFloatOrbitR * cos(gFloatAngle)
      targetY = cy + gFloatOrbitR * 0.6 * sin(gFloatAngle)
    # 2. 平滑移动鲸鱼
    gFishX += (targetX - gFishX) * 0.045
    gFishY += (targetY - gFishY) * 0.045
    # 3. 吐泡泡（每约 500ms 一个）
    inc gBubbleTimer
    if gBubbleTimer >= 10:
      gBubbleTimer = 0
      floatSpawnBubble()
    floatUpdateBubbles()
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
  # 2. 鲸鱼（over 合成，预乘；颜色按 gPetColor：0=蓝 1=黑 2=橙）
  #    提问闪烁（橙）时交替绘制"基态色"（最小化=蓝 / 打开=黑），
  #    即蓝↔橙 或 黑↔橙 交替（主 2026-08-16 定稿，替代"橙/消失"）
  if gFishPixelsLoaded:
    let drawColor = if gPetColor == 2 and not gPetBlinkOn: gPetBaseColor else: gPetColor
    let fx = int(gFishX) - FISH_BIN_W div 2
    let fy = int(gFishY) - FISH_BIN_H div 2
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
    # 初始化位置：屏幕右上角
    let sw = GetSystemMetrics(SM_CXSCREEN)
    discard SetWindowPos(gFloatHwnd, HWND_TOPMOST,
                         sw - FLOAT_W - 40, 80, 0, 0,
                         SWP_NOSIZE)
    # 初始化鲸鱼位置在圆心
    gFishX = FLOAT_W / 2.0
    gFishY = FLOAT_H / 2.0
    if gPetVisible:
      # 显示宠物（2026-08-16 主定稿：默认打开，托盘可隐藏）
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

# ---------- 窗口尺寸记忆 ----------

const SizeRegKey = "Software\\Bikini\\DSH-Nim-Client"

proc saveWindowSize(w, h: int) =
  var hKey: HKEY
  if RegCreateKeyExW(HKEY_CURRENT_USER, SizeRegKey.cstring, 0, nil, 0,
                     KEY_SET_VALUE, nil, hKey.addr, nil) == ERROR_SUCCESS:
    var wv = DWORD(w)
    var hv = DWORD(h)
    discard RegSetValueExW(hKey, "Width".cstring, 0, REG_DWORD,
                           cast[LPCBYTE](wv.addr), DWORD(sizeof(DWORD)))
    discard RegSetValueExW(hKey, "Height".cstring, 0, REG_DWORD,
                           cast[LPCBYTE](hv.addr), DWORD(sizeof(DWORD)))
    discard RegCloseKey(hKey)

proc loadWindowSize(): tuple[width, height: int] =
  result = (1280, 820)
  var hKey: HKEY
  if RegOpenKeyExW(HKEY_CURRENT_USER, SizeRegKey.cstring, 0,
                   KEY_QUERY_VALUE, hKey.addr) == ERROR_SUCCESS:
    var wv, hv: DWORD
    var size = DWORD(sizeof(DWORD))
    if RegQueryValueExW(hKey, "Width".cstring, nil, nil,
                        cast[LPBYTE](wv.addr), size.addr) == ERROR_SUCCESS:
      if wv > 400 and wv < 4000: result.width = int(wv)
    size = DWORD(sizeof(DWORD))
    if RegQueryValueExW(hKey, "Height".cstring, nil, nil,
                        cast[LPBYTE](hv.addr), size.addr) == ERROR_SUCCESS:
      if hv > 300 and hv < 3000: result.height = int(hv)
    discard RegCloseKey(hKey)

proc trackWindowSize() =
  let wnd = findMainWindow()
  if wnd != 0:
    var rect: RECT
    if GetWindowRect(wnd, rect.addr):
      let w = int(rect.right - rect.left)
      let h = int(rect.bottom - rect.top)
      if abs(w - gLastW) > 20 or abs(h - gLastH) > 20:
        gLastW = w
        gLastH = h
        saveWindowSize(w, h)

proc backendAlive(): bool =
  ## 探测 127.0.0.1:3080 是否可达（TCP 握手，300ms 超时）
  ## 后端不可达（WSL 重启/dsh web 挂）时停止窗口重建尝试，等后端恢复。
  ## 注（2026-08-15 排查实证）：窗口异常消失元凶是 subclass 主窗口（干扰 webui
  ## 初始化），不是 net 模块——3648 无 subclass + 本探活版本稳定无闪退。
  try:
    let s = newSocket()
    defer: s.close()
    s.connect("127.0.0.1", Port(3080), timeout = 300)
    return true
  except CatchableError:
    return false

proc fetchPetState(): int =
  ## 读 Windows 侧本地状态文件（终端服务写入），返回 0=蓝 1=黑 2=橙。
  ## 2026-08-16 崩溃修复：原 HTTP 轮询（net 模块 send/recv）在 Windows 触发
  ## 0xc0000005 访问冲突导致进程崩溃；改为读本地文件（纯文件 I/O，零网络）。
  ## 路径动态化（2026-08-16 主定稿）：%USERPROFILE%\\pet-state.json——
  ## 服务端写 Windows 用户目录根，不再硬编码用户名，换机可部署。
  try:
    let body = readFile(getEnv("USERPROFILE") & "\\pet-state.json")
    if body.contains("\"pet\":\"blue\""): return 0
    if body.contains("\"pet\":\"black\""): return 1
    if body.contains("\"pet\":\"orange\""): return 2
    return -1
  except CatchableError:
    return -1

# ---------- 主流程 ----------

when isMainModule:
  echo "[DSH-Nim] 启动中..."
  # 高精度定时器（60fps 动画需要，默认 15.6ms 粒度会卡）
  discard timeBeginPeriod(1)
  dbg("main start")
  discard SetProcessDPIAware()
  setupAutostart()
  dbg("autostart ok")

  # 创建宿主窗口（托盘载体）
  gHostHwnd = createHostWindow()
  dbg("host hwnd=" & $gHostHwnd)
  if gHostHwnd != 0:
    setupTray(gHostHwnd)
    echo "[DSH-Nim] 托盘已就绪"
    dbg("tray ok")

  # 打开 webui 窗口（嵌入式 WebView）
  # 关键：dsh web 不加载 webui.js，不建立 webui WebSocket 连接，
  # 默认 15 秒超时会把窗口判"未连接"关闭 → 必须 setTimeout(0) 无限等待。
  setTimeout(0)
  # 先设置尺寸再显示（webui 创建窗口时读 win->width/height，避免闪默认大小）
  let saved = loadWindowSize()
  gWindow = newWindow()
  gWindow.setSize(saved.width, saved.height)
  gLastW = saved.width
  gLastH = saved.height
  dbg("before showWv")
  let shown = gWindow.showWv(WebUrl)
  dbg("after showWv shown=" & $shown)

  # 悬浮鲸鱼图标（主窗口创建后再初始化，避免影响 webui 窗口）
  dbg("before floatInit")
  floatInit()
  dbg("after floatInit")

  # 设置窗口鲸鱼图标
  sleep(2000)
  let wnd = findMainWindow()
  if wnd != 0:
    let bigIcon = loadWhaleIcon(32)
    let smallIcon = loadWhaleIcon(16)
    discard SendMessageW(wnd, WM_SETICON, ICON_BIG, LPARAM(bigIcon))
    discard SendMessageW(wnd, WM_SETICON, ICON_SMALL, LPARAM(smallIcon))

  # 主循环：webui 事件 + Win32 消息（非阻塞共存）
  var msg: MSG
  var mainSeen = false  # 主窗口是否出现过（用于关闭检测）
  while gRunning:
    while PeekMessageW(msg.addr, 0, 0, 0, PM_REMOVE):
      discard TranslateMessage(msg.addr)
      discard DispatchMessageW(msg.addr)
    discard waitAsync()
    trackWindowSize()
    # 标题强制（5 秒低频；dsh web 前端把会话标题拼进页面 title，窗口标题会跟随）
    let tickT = GetTickCount64()
    if tickT - gLastTitleCheck > 5000:
      gLastTitleCheck = tickT
      forceMainWindowTitle()

    # 鼠标交互：鼠标进入放置位置 150px 半径范围 → 鲸鱼慢慢游向鼠标
    # （不依赖鼠标消息：WM_NCHITTEST 透明区穿透，鼠标消息收不到，
    #   改用 GetCursorPos 轮询，穿透区也能感知）
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

    # 同步窗口最小化状态
    let mw = findMainWindow()
    if mw != 0:
      mainSeen = true
      gWindowMinimized = IsIconic(mw) == 1

    # 窗口消失处理（v13 最终：无任何 webui 窗口挂钩，经主实测稳定不闪退）
    # 排查实证（2026-08-15）：subclass 与 close handler 等对 webui 窗口的挂钩
    # 都会干扰窗口初始化导致异常消失（v10/v12 实测闪退）；v13 无挂钩：
    # 窗口消失 → 后端可达则限频自动重建（点 ✕ 会弹回，退出走托盘"退出"），
    # 后端不可达（WSL 重启/dsh web 挂）→ 停止重建等恢复。
    if not gQuitting and mainSeen:
      let wnd = findMainWindow()
      if wnd == 0:
        inc gCloseCount
        if gCloseCount > 180 and not gBackendDown:  # 约 3 秒持续不存在才重建（防页面刷新误触发）
          let nowT = GetTickCount64()
          if nowT - gLastRetryTime > 3000:  # 限频 3 秒重建
            if backendAlive():
              dbg("window gone -> re-show")
              gLastRetryTime = nowT
              gWindow.setSize(gLastW, gLastH)
              discard gWindow.showWv(WebUrl)
            else:
              dbg("backend down -> wait")
              gBackendDown = true
          gCloseCount = 0
      else:
        gCloseCount = 0
        gBackendDown = false

    # 断连恢复：后端回来了 → 重建主窗口（webui 对已销毁窗口会重新创建）
    if gBackendDown and backendAlive():
      dbg("backend recovered -> re-show")
      gWindow.setSize(gLastW, gLastH)
      discard gWindow.showWv(WebUrl)
      gBackendDown = false

    # ---- 宠物颜色：提问(橙,文件) > 主窗口打开(黑) > 主窗口最小化/未现(蓝) ----
    # 2026-08-16 主定稿：颜色跟随客户端主窗口状态（打开=黑、最小化=蓝），
    # 终端面板开关不再影响颜色；提问橙色由状态文件驱动（客户端本地零网络）
    let petTick = GetTickCount64()
    let pollGap = if gPetPollOk: 1000 else: 5000   # 失败拉长间隔，少打扰主循环
    if petTick - gPetPollTick > pollGap:
      gPetPollTick = petTick
      let c = fetchPetState()
      gPetPollOk = c >= 0
      gAsking = c == 2
    # 基态色（非提问时颜色：最小化=蓝 0 / 打开=黑 1）——提问闪烁与它交替
    gPetBaseColor = if mainSeen and not gWindowMinimized: 1 else: 0
    var target = 0
    if gAsking:
      target = 2
    elif mainSeen and not gWindowMinimized:
      target = 1
    if target != gPetColor:
      gPetColor = target
      gPetBlinkOn = true
      floatPaint(gFloatHwnd)
      # 托盘图标跟随宠物颜色（蓝/黑/橙同色 ico）
      let tIcon = loadWhaleIcon(32, gPetColor)
      if tIcon != 0:
        gTrayData.hIcon = tIcon
        discard Shell_NotifyIconW(NIM_MODIFY, gTrayData.addr)
      dbg("pet color -> " & $target)
    if gPetColor == 2:
      if petTick - gPetBlinkTick >= 400:
        gPetBlinkTick = petTick
        gPetBlinkOn = not gPetBlinkOn
        floatPaint(gFloatHwnd)

    sleep(FLOAT_ANIM_MS)
