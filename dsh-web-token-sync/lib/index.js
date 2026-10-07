// dsh-web-token-sync：dsh web 启动后自动把带 token 的认证 URL 写入
// <用户目录>/.dsh/dsh-web-token.txt，免手动维护。
// 2026-10-07 主：统一收进 ~/.dsh（原先散落在桌面各客户端目录，既乱又与多版本副本耦合）。
// WSL 下 <用户目录> 解析为 Windows 侧用户目录（/mnt/c/Users/<user>），
// 原生 Linux/macOS 则用系统家目录 —— 两种环境同一份代码都能工作。
//
// 背景：dsh web 0.1.2-rc.1 起每次进程启动生成一次性 launch token（仅内存，
// 打印在启动 URL）。客户端 WebView 首次需带 token 完成认证交换。
// 本插件在进程内调 connection.authenticatedUrl() 拿到与本进程一致的 token URL
// （同 root 同 launch token），写入 exe 同目录文件 —— 客户端保持读文件即可。
//
// 注意：不修改 dsh 本体任何代码，随 profile 加载；dsh 升级后若插件 API 变化
// 只需对本插件做适配。

import { mkdirSync, readdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

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
 * 统一解析“用户目录”：WSL 下映射到 Windows 侧用户目录（让文件对 Windows 客户端可见），
 * 原生 Linux/macOS 用系统家目录。token 文件固定放 <用户目录>/.dsh/dsh-web-token.txt。
 */
function userHome() {
  return winUserHome() || os.homedir();
}

/**
 * apply：服务就绪后把带 token 的 URL 写入 targetDir/dsh-web-token.txt。
 * @param ctx - 插件上下文（inject 声明使 ctx.connection / ctx.webServer 可用）
 * @param config - 可选配置 { targetDir?: string }（默认 <Windows用户目录>/Desktop/DSH-Pet-Client）
 */
/**
 * 找桌面下所有 DSH 客户端运行目录（名字以 DSH-Pet-Client 开头且内含
 * dsh_client_full.exe 的目录，兼容 v2.1.x 的 DSH-Pet-Client 与 v2.2 起的
 * DSH-Pet-Client-v2.x 多版本并存），全部写入 token 文件——用户实际运行哪个
 * 副本都能读到。2026-09-06 修复：原写死 Desktop/DSH-Pet-Client 导致 v2.2 目录
 * 下的 exe 读不到 token。
 */
function clientDirs(home) {
  const desktop = path.join(home, "Desktop");
  try {
    const out = [];
    for (const name of readdirSync(desktop)) {
      const p = path.join(desktop, name);
      if (!name.startsWith("DSH-Pet-Client")) continue;
      let isDir = false;
      try { isDir = statSync(p).isDirectory(); } catch (e) {}
      if (!isDir) continue;
      // 目录内含 exe 才算运行目录（不含 exe 的空壳目录不写，避免自动建目录误导）
      try { if (readdirSync(p).includes("dsh_client_full.exe")) out.push(p); } catch (e) {}
    }
    return out;
  } catch {
    return [];
  }
}

export function apply(ctx, config) {
  const targetDir = config?.targetDir;
  try {
    const home = userHome();
    if (!home) throw new Error("无法解析用户目录");
    const port = ctx.webServer?.port;
    if (port === undefined) throw new Error("webServer.port 不可用");
    const authUrl = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}`);
    // 目标目录：显式配置 > <用户目录>/.dsh（2026-10-07 定；不再散写桌面各客户端目录）
    const dirs = targetDir ? [targetDir] : [path.join(home, ".dsh")];
    if (dirs.length === 0) {
      ctx.logger?.info?.("[dsh-web-token-sync] 未找到 DSH 客户端运行目录，跳过 token 写入");
      return;
    }
    for (const dir of dirs) {
      try {
        mkdirSync(dir, { recursive: true });
        const target = path.join(dir, "dsh-web-token.txt");
        writeFileSync(target, `${authUrl}\n`, "utf8");
        ctx.logger?.info?.(`[dsh-web-token-sync] 已写入认证 URL -> ${target}`);
      } catch (e) {
        ctx.logger?.warn?.(`[dsh-web-token-sync] 写入 ${dir} 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (error) {
    ctx.logger?.warn?.(
      `[dsh-web-token-sync] 写入失败: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
