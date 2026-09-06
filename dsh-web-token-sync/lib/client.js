// dsh-web-token-sync 页面端（v2.2 模式切换自动刷新）：
// 订阅 3081 SSE /api/events，收到 reload 事件即 location.reload()——dsh-mode.sh
// 切换完成 POST /api/notify-reload 广播。事件驱动零轮询。
// 本插件在纯净模式(--patch clean)也保留 → 纯净/完整两模式页面都能自动刷新。
// 注意：ModuleLoader.load 的 id 必须 = 插件名 "dsh-web-token-sync"（此前误用
// dsh-web-token-sync-client 导致 'loaded without registering' 页面崩溃，db0215f
// 回退后按 dsh-mnemon/dshmarket 双端插件模式重做，2026-09-06）。
window.__ModuleLoader__.load({
	id: "dsh-web-token-sync",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		function apply() {
			// 防重复注入（runtime 可能多次 apply）
			if (document.getElementById("dsh-token-sync-reload")) return;
			const mark = document.createElement("div");
			mark.id = "dsh-token-sync-reload";
			mark.style.display = "none";
			document.body.appendChild(mark);
			try {
				const es = new EventSource("http://127.0.0.1:3081/api/events");
				es.addEventListener("reload", () => location.reload());
			} catch (e) {}
		}
		module.exports = { apply, inject: [] };
		return module.exports;
	}
});
