# DSH Nim 桌面客户端
# 加载 WSL 内的 dsh web (http://127.0.0.1:3080)
# 依赖: nimble install webview
import webview

const WebUrl = "http://127.0.0.1:3080"

when isMainModule:
  let w = newWebView(
    title = "DeepSeek Harness",
    url = WebUrl,
    width = 1280,
    height = 820,
    resizable = true
  )
  if w.init() != 0:
    quit("webview 初始化失败")
  discard w.loop(1)
