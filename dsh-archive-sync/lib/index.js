// dsh-archive-sync：让「已归档会话恢复」免重启即时生效。
//
// 背景（2026-09-10 用户需求）：
//   dsh 把归档集合 archivedSessionIds 读进内存（workspaceRegistry.requireState()），
//   而官方设计上归档是单向的 —— dsh-workspace/README 原文 "Archiving is one-way …
//   no unarchive action exists yet"，服务端只有 archiveSession、没有移除方法。
//   我们的「已归档会话恢复」只能改 ~/.dsh/storages/workspace.json，改完 dsh 内存不变，
//   于是必须重启 dsh web 才看得到 —— 每次恢复都要重启一次。
//
// 本插件在 dsh 进程内轮询该文件：发现归档集合与内存不一致时，用 registry 自己的
// setState 同步（持久化与前端通知都由 dsh 自己完成）→ 恢复瞬间生效、零重启。
// 另外在启动时做一次"已删除会话结算"（清墓碑/孤儿归档项），见文件末尾说明。
//
// 说明：setState / requireState / enqueueOperation 是 dsh-workspace 的实例方法
// （非公开命令 API），dsh 升级后若改名只需适配本插件；任何异常只记日志，
// 绝不影响 dsh 本体运行。

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

      const parsed = JSON.parse(readFileSync(statePath, "utf8"));
      syncing = true;

      // A) 归档集合（存在 state 里，用 setState 同步）
      const ids = parsed?.global?.archivedSessionIds;
      if (Array.isArray(ids)) {
        const current = reg.archivedSessionIds;
        if (!sameIds(current, ids)) {
          await reg.enqueueOperation(async () => {
            const state = reg.requireState();
            await reg.setState({ ...state, archivedSessionIds: ids });
            ctx.logger?.info?.(
              `[dsh-archive-sync] 归档集合已同步（${current?.length ?? "?"} → ${ids.length}），无需重启`
            );
          });
        }
      }

      // 说明（2026-09-11 实测）：不再尝试同步 workspace 的 sessionIds ——
      // dsh 的会话"真相"是它内存里的 headers 索引（只在启动等时机重建），
      // 从外部用 table.update 改 sessionIds 会被 dsh 随后按索引写回，反而制造
      // order/table 不一致。删除会话只能靠重启 dsh web 让它重建索引。
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

  // ---------- 已删除会话的"结算"（只在启动时做一次，不轮询） ----------
  //
  // 2026-09-11 主定方案：
  //   删除 = 目录立刻删（体感即时）+ ID 留在归档集合里（工作区永久隐藏）；
  //   归档集合里的这条成为"墓碑"，只在 dsh 重启（本插件启动）时结算掉。
  // 为什么不能运行中清理：dsh 的会话"真相"是内存里的 headers 索引，
  //   目录删掉后索引里还在，一旦把 ID 从归档集合移除，会话就会重新出现在工作区
  //   （这正是旧版"每 5 秒扫孤儿"造成的 bug：删了又回到工作区、要刷新才消失）。
  // 启动时 dsh 已按磁盘重建索引，此时结算安全且彻底。

  const SESSIONS_ROOT = path.join(os.homedir(), ".dsh", "sessions");
  /** 删除挂起清单：终端服务删会话时写，本插件启动时读并清空（前端也用它过滤） */
  const PENDING_FILE =
    config?.pendingPath || path.join(os.homedir(), ".dsh", "storages", "dsh-pending-deletes.json");

  const sessionExists = (id) => {
    try {
      for (const scope of readdirSync(SESSIONS_ROOT)) {
        if (existsSync(path.join(SESSIONS_ROOT, scope, id))) return true;
      }
    } catch {
      return true; // 读不到就当作存在，宁可不清理
    }
    return false;
  };

  const readPending = () => {
    try {
      const parsed = JSON.parse(readFileSync(PENDING_FILE, "utf8"));
      return Array.isArray(parsed?.ids) ? parsed.ids : [];
    } catch {
      return [];
    }
  };

  const removeSessionDir = (id) => {
    try {
      for (const scope of readdirSync(SESSIONS_ROOT)) {
        const dir = path.join(SESSIONS_ROOT, scope, id);
        try {
          if (statSync(dir).isDirectory()) rmSync(dir, { recursive: true, force: true });
        } catch {
          /* 单个目录失败不影响其它 */
        }
      }
    } catch {
      /* 根目录读不到就跳过 */
    }
  };

  /** 一次性结算：清掉"已删除会话"的墓碑 + 目录已被删的孤儿归档项 */
  const settleDeleted = async () => {
    const pending = new Set(readPending());
    for (const id of pending) removeSessionDir(id); // 兜底：目录还在就删干净
    const ids = reg.archivedSessionIds;
    if (!Array.isArray(ids) || ids.length === 0) return;
    const drop = ids.filter((id) => pending.has(id) || !sessionExists(id));
    if (drop.length === 0) return;
    const dropSet = new Set(drop);
    await reg.enqueueOperation(async () => {
      const state = reg.requireState();
      await reg.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => !dropSet.has(id))
      });
    });
    ctx.logger?.info?.(`[dsh-archive-sync] 启动结算：已彻底移除 ${drop.length} 个已删除会话`);
  };

  // 启动结算（一次性，不轮询）。延迟一拍让 registry 索引重建先落地。
  const settleTimer = setTimeout(() => {
    void (async () => {
      try {
        await settleDeleted();
        writeFileSync(PENDING_FILE, JSON.stringify({ ids: [] }, null, 2), "utf8");
      } catch (error) {
        ctx.logger?.warn?.(
          `[dsh-archive-sync] 启动结算失败: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();
  }, 1000);

  const timer = setInterval(() => {
    void sync();
  }, POLL_MS);
  try {
    ctx.effect?.(() => () => {
      clearInterval(timer);
      clearTimeout(settleTimer);
    }, "dsh-archive-sync.timer");
  } catch {
    /* 清理钩子不可用也不影响正确性 */
  }

  ctx.logger?.info?.(`[dsh-archive-sync] 已启动，监听 ${statePath}`);
}
