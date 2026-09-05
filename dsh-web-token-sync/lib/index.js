// dsh-web-token-sync：dsh web 启动后自动把带 token 的认证 URL 写入 Windows 桌面
// 客户端 token 文件（dsh-web-token.txt），让 pet client 每次启动读到最新 token，
// 免手动维护。
//
// 背景：dsh web 0.1.2-rc.1 起每次进程启动生成一次性 launch token（仅内存，
// 打印在启动 URL）。客户端 WebView 首次需带 token 完成认证交换。
// 本插件在进程内调 connection.authenticatedUrl() 拿到与本进程一致的 token URL
// （同 root 同 launch token），写入 exe 同目录文件 —— 客户端保持读文件即可。
//
// 注意：不修改 dsh 本体任何代码，随 profile 加载；dsh 升级后若插件 API 变化
// 只需对本插件做适配。

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 稳定插件名（cordis loader 用） */
export const name = "dsh-web-token-sync";

/** 依赖服务：connection（client-connection 提供，含 BrowserAuth/authenticatedUrl）与 webServer（取监听端口） */
export const inject = ["connection", "webServer"];

/** WSL 里解析 Windows 用户目录：/mnt/c/Users/<用户名>/（排除系统内置与隐藏目录） */
function winUserHome() {
  try {
    const users = "/mnt/c/Users";
    const entries = readdirSync(users).filter(
      (d) =>
        !["Public", "Default", "Default User", "All Users"].includes(d) &&
        !d.startsWith(".") &&
        d !== "desktop.ini"
    );
    return entries.length > 0 ? path.join(users, entries[0]) : null;
  } catch {
    return null;
  }
}

/**
 * apply：服务就绪后把带 token 的 URL 写入 targetDir/dsh-web-token.txt。
 * @param ctx - 插件上下文（inject 声明使 ctx.connection / ctx.webServer 可用）
 * @param config - 可选配置 { targetDir?: string }（默认 <Windows用户目录>/Desktop/DSH-Pet-Client）
 */
export function apply(ctx, config) {
  const targetDir = config?.targetDir;
  try {
    const home = winUserHome();
    if (!home) throw new Error("未找到 /mnt/c/Users 下的 Windows 用户目录");
    const dir = targetDir ?? path.join(home, "Desktop", "DSH-Pet-Client");
    const port = ctx.webServer?.port;
    if (port === undefined) throw new Error("webServer.port 不可用");
    const authUrl = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}`);
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "dsh-web-token.txt");
    writeFileSync(target, `${authUrl}\n`, "utf8");
    ctx.logger?.info?.(`[dsh-web-token-sync] 已写入认证 URL -> ${target}`);
  } catch (error) {
    ctx.logger?.warn?.(
      `[dsh-web-token-sync] 写入失败: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
