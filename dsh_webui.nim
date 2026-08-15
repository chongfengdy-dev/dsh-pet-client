# DSH Nim 桌面客户端 (webui 路线)
# 嵌入式 WebView 加载 WSL 内的 dsh web
# 编译: nim c --path:"<webui-nim路径>" -d:release dsh_webui.nim
import webui

const WebUrl = "http://127.0.0.1:3080"

when isMainModule:
  let window = newWindow()
  # 直接加载 URL（showWv 支持 http:// URL）
  discard window.showWv(WebUrl)
  wait()
