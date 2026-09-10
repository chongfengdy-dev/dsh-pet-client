// dsh-archive-sync：让「已归档会话恢复」免重启即时生效。
//
// 背景（2026-09-10 主需求）：
//   dsh 把归档集合 archivedSessionIds 读进内存（workspaceRegistry.requireState()），
//   而官方设计上归档是单向的 —— dsh-workspace/README 原文 "Archiving is one-way …
//   no unarchive action exists yet"，服务端只有 archiveSession、没有移除方法。
//   我们的「已归档会话恢复」只能改 ~/.dsh/storages/workspace.json，改完 dsh 内存不变，
//   于是必须重启 dsh web 才看得到 —— 每次恢复都要重启一次。
//
// 本插件在 dsh 进程内轮询该文件：发现归档集合与内存不一致时，用 registry 自己的
// setState 同步（持久化与前端通知都由 dsh 自己完成）→ 恢复瞬间生效、零重启。
//
// 说明：setState / requireState / enqueueOperation 是 dsh-workspace 的实例方法
// （非公开命令 API），dsh 升级后若改名只需适配本插件；任何异常只记日志，
// 绝不影响 dsh 本体运行。

import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 稳定插件名（cordis loader 用） */
export const name = "dsh-archive-sync";

/** 依赖服务：workspaceRegistry（dsh-workspace 提供，含 archivedSessionIds / setState） */
export const inject = ["workspaceRegistry"];

/** 轮询间隔。文件很小（~1.4KB），1s 一次开销可忽略；
 *  不用 fs.watch 是因为写方用原子替换（rename），会让 watch 绑定的 inode 失效。 */
const POLL_MS = 1000;

export function apply(ctx, config) {
  const reg = ctx.workspaceRegistry;
  const statePath =
    config?.statePath || path.join(os.homedir(), ".dsh", "storages", "workspace.json");

  if (!reg || typeof reg.setState !== "function" || typeof reg.requireState !== "function") {
    ctx.logger?.warn?.("[dsh-archive-sync] workspaceRegistry API 不可用，插件跳过");
    return;
  }

  let lastMtime = 0;
  let syncing = false;

  const sameIds = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

  const sync = async () => {
    if (syncing) return;
    try {
      const st = statSync(statePath);
      if (st.mtimeMs === lastMtime) return; // 文件未变动 → 零开销退出
      lastMtime = st.mtimeMs;

      const ids = JSON.parse(readFileSync(statePath, "utf8"))?.global?.archivedSessionIds;
      if (!Array.isArray(ids)) return;

      const current = reg.archivedSessionIds;
      if (sameIds(current, ids)) return; // 内存已一致（含 dsh 自己写盘那次）

      syncing = true;
      await reg.enqueueOperation(async () => {
        const state = reg.requireState();
        await reg.setState({ ...state, archivedSessionIds: ids });
        ctx.logger?.info?.(
          `[dsh-archive-sync] 归档集合已同步进内存（${current?.length ?? "?"} → ${ids.length}），无需重启`
        );
      });
    } catch (error) {
      ctx.logger?.warn?.(
        `[dsh-archive-sync] 同步失败: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      syncing = false;
    }
  };

  try {
    lastMtime = statSync(statePath).mtimeMs; // 启动时以现状为基线，不在启动瞬间重复写
  } catch {
    /* 文件暂不存在也无妨，后续轮询会处理 */
  }

  const timer = setInterval(() => {
    void sync();
  }, POLL_MS);
  try {
    ctx.effect?.(() => () => clearInterval(timer), "dsh-archive-sync.timer");
  } catch {
    /* 清理钩子不可用也不影响正确性 */
  }

  ctx.logger?.info?.(`[dsh-archive-sync] 已启动，监听 ${statePath}`);
}
