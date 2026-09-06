// dsh-web-token-sync 页面端：订阅 3081 SSE /api/events，收到 reload 事件即刷新页面。
// 背景（v2.2 主需求）：纯净/完整模式切换由 dsh-mode.sh 完成（dsh web 重启，
// 页面连接断开、需手动 F5）——dsh-mode.sh 完成后 POST 3081 /api/notify-reload，
// 本订阅收到事件即 location.reload()（事件驱动、零轮询）。
// token-sync 在纯净模式(--patch clean)也保留，故完整/纯净两模式页面都能自动刷新。
window.__ModuleLoader__.load({
	id: "dsh-web-token-sync-client",
	factory: (require) => {
		var module = { exports: {} };
		// 页面顶层注册：SSE 长连 3081（独立于 dsh web，web 重启不断连）
		try {
			const es = new EventSource("http://127.0.0.1:3081/api/events");
			es.addEventListener("reload", () => location.reload());
		} catch (e) {}
		module.exports = {
			apply() {},
			inject: [],
		};
		return module.exports;
	}
});
