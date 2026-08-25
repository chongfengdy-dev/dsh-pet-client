// dsh-wechat — 微信通道插件主入口（2026-08-18）
// 常驻轮询 iLink getupdates → 微信消息按 peer 喂给 agent（会话复用=上下文连续）
// → sendmessage 回复；另起 127.0.0.1:<send_port> POST /send 供主动推送（选股 --push 等）。
// 凭证在 profile 的 cordis.patch.yml 配置（wechat-channel.config）。
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { getUpdates, sendMessage, extractText } from "./ilink.js";

export const name = "dsh-wechat";
export const inject = ["agentDefaultModel", "agents", "sessions"];

const Config = z.object({
	peer: z.string().required(),          // 主微信账号 id（o9cq...@im.wechat）
	uin: z.string().required(),           // X-Wechat-Uin（base64）
	bot_id: z.string().required(),        // e69019ad4f22@im.bot
	device_id: z.string().required(),     // 060000...
	account_id: z.string().default(""),
	base_url: z.string().default("https://ilinkai.weixin.qq.com"),
	long_poll_ms: z.number().default(35000),
	send_port: z.number().default(3082),  // 本地 send 服务端口（127.0.0.1）
});

// 初始 get_updates_buf（协议实测捕获，含 bot_id:device_id 会话标识）
const INITIAL_UPDATES_BUF = "ChAIRBDT86GPgTQYyqLstuozEjplNjkwMTlhZDRmMjJAaW0uYm90OjA2MDAwMGEyNzBjZDE5YTM3ZDA1MTBmZTdmODkxMjkxYmU3YWZk";

function dshHome() {
	return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

// 检查 session 是否已持久化在磁盘（复刻 dsh-session-persistence-jsonl 的目录编码：
// projectKey(cwd) 把 / \ : 换为 -、特殊字符转 ~XXXX；id 同样 ~XXXX 转义）
function encodeSegment(raw) {
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
	}
	return out;
}
function projectKey(cwd) {
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
function hasPersistedSession(sessionId, cwd = process.cwd()) {
	try {
		const root = path.join(dshHome(), "sessions");
		const dir = path.join(root, projectKey(cwd), encodeSegment(sessionId));
		return fs.existsSync(path.join(dir, "session.jsonl.zstd")) ||
			fs.existsSync(path.join(dir, "session.jsonl"));
	} catch { return false; }
}
function syncFile(cfg) {
	const dir = path.join(dshHome(), "wechat");
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, (cfg.account_id || cfg.peer).replace(/[^\w@.-]/g, "_") + ".sync.json");
}
function loadSyncBuf(cfg) {
	try { return JSON.parse(fs.readFileSync(syncFile(cfg), "utf8")).get_updates_buf || null; } catch { return null; }
}
function saveSyncBuf(cfg, buf) {
	try { fs.writeFileSync(syncFile(cfg), JSON.stringify({ get_updates_buf: buf })); } catch { /* 忽略 */ }
}

// 微信会话不进 GUI 列表：把会话 id 写进 storages/workspace.json 的 archivedSessionIds（幂等）
function ensureSessionArchived(sessionId) {
	try {
		const p = path.join(dshHome(), "storages", "workspace.json");
		const data = JSON.parse(fs.readFileSync(p, "utf8"));
		const arr = (data.global && data.global.archivedSessionIds) || [];
		if (!arr.includes(sessionId)) {
			arr.push(sessionId);
			if (!data.global) data.global = {};
			data.global.archivedSessionIds = arr;
			fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
		}
	} catch { /* 忽略 */ }
}

// 聚合一轮 turn 的最终 assistant 文本（参考 dsh-headless summarize）
function summarizeReply(session, firstSeq) {
	let text = "", reason;
	for (const ev of session.events) {
		if (ev.seq < firstSeq) continue;
		if (ev.type === "turn/start") continue;
		if (ev.type === "assistant/message") {
			const joined = (ev.data?.message?.content || [])
				.filter((b) => b.type === "text")
				.map((b) => b.text).join("");
			if (joined !== "") text = joined;
		}
		if (ev.type === "turn/end") reason = ev.data?.reason;
	}
	return { text, reason };
}

// 按 peer 调 agent（会话复用：同 peer 复用同一 agent/session，上下文连续）
async function askAgent(state, ctx, peerKey, userText) {
	const agents = ctx.get("agents");
	const defaultModel = ctx.get("agentDefaultModel");
	const sessions = ctx.get("sessions");
	if (!agents || !defaultModel || !sessions) return "（微信通道未就绪）";
	const selection = defaultModel.currentSelection();
	const rawSessionId = "session-wechat-" + createHash("sha1").update(peerKey).digest("hex").slice(0, 12);
	const sessionId = SessionId(rawSessionId);
	let entry = state.agents.get(peerKey);
	if (!entry) {
		// 2026-08-25 修复：dsh 0.1.1-rc.2 起会话持久化校验加强——磁盘已有该 session
		// 日志时 create 会撞 adoptLivePrefix 校验（id collision），须用 resume 恢复。
		// 存在持久化 session 文件 → resume；否则 create。
		const sessionExists = hasPersistedSession(rawSessionId);
		let agent;
		if (sessionExists) {
			({ agent } = await agents.resume({
				resumeSessionId: sessionId,
				agentOptions: { provider: selection.provider, model: selection.model },
				setup: (agentCtx) => {
					installModelSelection(agentCtx, { current: selection, assembled: void 0 });
				},
			}));
		} else {
			({ agent } = await agents.create({
				sessionId,
				meta: { cwd: process.cwd() },
				agentOptions: { provider: selection.provider, model: selection.model },
				setup: (agentCtx) => {
					installModelSelection(agentCtx, { current: selection, assembled: void 0 });
				},
			}));
		}
		entry = { agent };
		state.agents.set(peerKey, entry);
		ensureSessionArchived(rawSessionId);   // 微信会话隐藏出 GUI 列表
	}
	await entry.agent.whenIdle();
	const firstSeq = entry.agent.session.seq;
	entry.agent.followup(createUserMessage({
		content: [{ type: "text", text: userText }],
		source: { kind: "user" },
	}));
	await entry.agent.whenIdle();
	await sessions.flush(entry.agent.session);
	const { text, reason } = summarizeReply(entry.agent.session, firstSeq);
	if (reason?.kind === "error") return "（处理出错：" + (reason.error?.code || "unknown") + "）";
	return text || "（无回复）";
}

async function handleMessage(state, ctx, cfg, m) {
	const peer = m.from_user_id || cfg.peer;
	const text = extractText(m.item_list);
	const ctxToken = m.context_token || "";
	if (!text || !text.trim()) return;
	const reply = await askAgent(state, ctx, peer, text);
	await sendMessage(cfg, { to: peer, text: reply, contextToken: ctxToken });
}

// 本地 send 服务：POST /send {"text": "...", "to": "可选"} → 主动推微信
function startSendService(cfg) {
	const server = http.createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/send") { res.writeHead(404); res.end(); return; }
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", async () => {
			try {
				const { text, to } = JSON.parse(body || "{}");
				if (!text) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, err: "text required" })); return; }
				const r = await sendMessage(cfg, { to: to || cfg.peer, text: String(text) });
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: !r.errcode || r.errcode === 0, ...r }));
			} catch (e) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, err: String(e?.message || e) }));
			}
		});
	});
	server.listen(cfg.send_port, "127.0.0.1");
	return server;
}

async function pollLoop(state, ctx, cfg) {
	let buf = loadSyncBuf(cfg) || INITIAL_UPDATES_BUF;
	while (!state.stopped) {
		const r = await getUpdates(cfg, buf, cfg.long_poll_ms || 35000);
		if (r.errcode != null && r.errcode !== 0) {
			console.error(`[wechat] getupdates errcode=${r.errcode} errmsg=${r.errmsg}`);
			await new Promise((s) => setTimeout(s, 5000));
			continue;
		}
		if (r.get_updates_buf) { buf = r.get_updates_buf; saveSyncBuf(cfg, buf); }
		for (const m of r.msgs || []) {
			if (!m) continue;
			try { await handleMessage(state, ctx, cfg, m); }
			catch (e) { console.error("[wechat] handleMessage error:", e); }
		}
	}
}

export function apply(ctx, config = {}) {
	// cordis 的 ctx 是代理对象，不能挂自定义属性 → 用闭包 state 保存运行状态
	const state = { stopped: false, agents: new Map() };
	const server = startSendService(config);
	ctx.on("dispose", () => {
		state.stopped = true;
		try { server.close(); } catch { /* 忽略 */ }
	});
	console.log(`[wechat] 启动 peer=${config.peer} send=127.0.0.1:${config.send_port} (LONG_POLL=${config.long_poll_ms || 35000}ms)`);
	pollLoop(state, ctx, config).catch((e) => console.error("[wechat] poll loop error:", e));
}
