// dsh-term-panels 服务端入口：纯前端插件，服务端无逻辑。
// 仅作为 cordis loader entry 存在（client-modules 需要 loader 认识本包才能
// 加载 ./client.js 前端模块）。
export const name = "dsh-term-panels";

export function apply(ctx) {
	// 无服务端逻辑；前端功能见 ./client.js（右侧悬浮按钮块 + 终端/Token 面板）
}
