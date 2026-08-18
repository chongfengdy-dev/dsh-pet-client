// dsh-wechat — iLink 协议客户端（Node 版，2026-08-18 从原 python 桥接协议重建）
// 协议要点（实测确认）：
//   getupdates:  POST /ilink/bot/getupdates   body={get_updates_buf, base_info:{channel_version:"2.2.0"}}
//   sendmessage: POST /ilink/bot/sendmessage  body={msg:{from_user_id:"",to_user_id,client_id:"dsh-weixin-<uuid>",
//                message_type:2,message_state:2,item_list:[{type:1,text_item:{text}}],context_token},
//                base_info:{channel_version:"2.2.0"}}
//   头：Authorizationtype:ilink_bot_token / X-Wechat-Uin(凭证) / Ilink-App-Id:bot /
//       Ilink-App-Clientversion:131584 / Authorization: Bearer <bot_id>:<device_id>
import { randomUUID } from "node:crypto";

const BASE = "https://ilinkai.weixin.qq.com";
const EP_GET_UPDATES = "/ilink/bot/getupdates";
const EP_SEND_MESSAGE = "/ilink/bot/sendmessage";
export const CHANNEL_VERSION = "2.2.0";
export const APP_ID = "bot";
export const APP_CLIENT_VERSION = "131584"; // (2<<16)|512
export const MSG_TYPE_BOT = 2;
export const MSG_STATE_FINISH = 2;
export const ITEM_TEXT = 1;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// 凭证字段：{ peer, uin, bot_id, device_id, account_id, base_url }
export function makeHeaders(cfg) {
	return {
		Authorizationtype: "ilink_bot_token",
		"X-Wechat-Uin": cfg.uin,
		"Ilink-App-Id": APP_ID,
		"Ilink-App-Clientversion": APP_CLIENT_VERSION,
		Authorization: `Bearer ${cfg.bot_id}:${cfg.device_id}`,
		"Content-Type": "application/json",
		"User-Agent": UA,
	};
}

async function post(cfg, path, body, timeoutMs) {
	const res = await fetch((cfg.base_url || BASE) + path, {
		method: "POST",
		headers: makeHeaders(cfg),
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return { ret: -1, errmsg: `bad json: ${text.slice(0, 120)}` };
	}
}

// 长轮询 getupdates：buf 为上次的 get_updates_buf（sync 状态），返回 {msgs, sync_buf, get_updates_buf, errcode?, errmsg?}
export async function getUpdates(cfg, buf, longPollMs) {
	longPollMs = longPollMs || 35000;
	try {
		const r = await post(cfg, EP_GET_UPDATES, {
			get_updates_buf: buf,
			base_info: { channel_version: CHANNEL_VERSION },
		}, longPollMs + 8000);
		return r;
	} catch (e) {
		return { ret: -1, errmsg: String(e?.message || e) };
	}
}

// 发送消息：text 为纯文本；contextToken 为回复时的上下文令牌（主动推送传 ""）
export async function sendMessage(cfg, { to, text, contextToken = "" }) {
	try {
		return await post(cfg, EP_SEND_MESSAGE, {
			msg: {
				from_user_id: "",
				to_user_id: to,
				client_id: "dsh-weixin-" + randomUUID(),
				message_type: MSG_TYPE_BOT,
				message_state: MSG_STATE_FINISH,
				item_list: [{ type: ITEM_TEXT, text_item: { text } }],
				context_token: contextToken,
			},
			base_info: { channel_version: CHANNEL_VERSION },
		}, 30000);
	} catch (e) {
		return { ret: -1, errmsg: String(e?.message || e) };
	}
}

// 从消息 item_list 提取纯文本
export function extractText(itemList) {
	const list = Array.isArray(itemList) ? itemList : [];
	return list
		.filter((it) => it?.type === ITEM_TEXT)
		.map((it) => it?.text_item?.text || "")
		.join("");
}
