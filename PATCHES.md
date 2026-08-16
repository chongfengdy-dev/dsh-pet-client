# 本地补丁（编译客户端必需）

## webui.c — WebView2 缓存目录固定（持久化关键）

`webui-nim/webui/webui/src/webui.c`（约 13621 行）原逻辑为每次启动生成**随机缓存目录**
（`WebUIWebViewCache_<随机数>`），导致 WebView2 的 localStorage 每次全新（终端设置/面板
几何无法跨启动保留）。

**补丁**：将
```c
WEBUI_SN_PRINTF_DYN(_webui.webview_cacheFolder, WEBUI_MAX_PATH,
    "%s%s.WebUI%sWebUIWebViewCache_%"PRIu32, temp, os_sep, os_sep,
    _webui_generate_random_uint32());
```
改为固定路径（去掉随机数后缀）：
```c
WEBUI_SN_PRINTF_DYN(_webui.webview_cacheFolder, WEBUI_MAX_PATH,
    "%s%s.WebUI%sWebUIWebViewCache", temp, os_sep, os_sep);
```

dsh-term-panels 插件自带服务端持久化（3081 /api/term-state），此补丁额外保证
WebView2 内其他 localStorage 也持久。
