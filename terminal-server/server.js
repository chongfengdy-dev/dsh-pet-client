#!/usr/bin/env node
// DSH-Pet-Client 集成终端服务
// 架构：express(静态页面) + ws(终端 IO 通道) + node-pty(bash 真 PTY)
// 端口 3081，只绑定 127.0.0.1（WSL 内部回环；Windows 客户端经 WSL2 localhost
// 转发访问，与 3080 dsh-web 同一原理）。
// 安全说明：自用版仅绑回环地址；如需对外暴露必须加 token 校验（见 TODO）。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const PORT = 3081;
const HOST = '127.0.0.1';

const app = express();
// no-store：终端页面每次重开都取最新版（WebView2 会缓存静态资源，
// 之前改完页面主端仍显示旧版很可能就是缓存）
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  },
}));
// xterm.js 前端库（npm 包本地托管，离线可用）
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm/lib')));
app.use('/vendor/xterm/css', express.static(path.join(__dirname, 'node_modules/@xterm/xterm/css')));
app.use('/vendor/fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit/lib')));

// ---------- DeepSeek 余额代理（Token HUD 用） ----------
// 读 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY，调 /user/balance；
// 结果缓存 2 分钟（DeepSeek 该接口有频率限制）。仅绑 127.0.0.1，自用安全。
const https = require('https');

function readDeepSeekKey() {
  try {
    const yaml = fs.readFileSync(path.join(os.homedir(), '.dsh/.credentials.yaml'), 'utf8');
    const m = yaml.match(/^DEEPSEEK_API_KEY:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch (e) {
    return null;
  }
}

let balanceCache = { at: 0, data: null };
// CORS：dsh web 前端（3080）跨域 fetch 本接口
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '20mb' }));   // 20MB：宠物状态小请求 + 图片 base64 上传

// ---------- 终端图片背景（上传 + 静态托管） ----------
// 插件设置面板选图 → POST base64 → 存 backgrounds/ → termHost 背景引用
const BG_DIR = path.join(__dirname, 'backgrounds');
fs.mkdirSync(BG_DIR, { recursive: true });
app.use('/backgrounds', express.static(BG_DIR, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  },
}));
app.post('/api/background', (req, res) => {
  const { data, ext } = req.body || {};
  if (!data || !ext) return res.status(400).json({ error: 'missing data/ext' });
  const allowed = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
  if (!allowed.includes(String(ext).toLowerCase())) {
    return res.status(400).json({ error: 'unsupported type' });
  }
  const buf = Buffer.from(String(data), 'base64');
  if (buf.length === 0 || buf.length > 15 * 1024 * 1024) {
    return res.status(400).json({ error: 'invalid or too large' });
  }
  const file = 'bg.' + String(ext).toLowerCase();
  fs.writeFileSync(path.join(BG_DIR, file), buf);
  console.log(`[term] background updated: ${file} (${buf.length} bytes)`);
  res.json({ url: '/backgrounds/' + file });
});

// ---------- 宠物状态（dsh web 插件 → 客户端 Nim） ----------
// pet: 'blue'（终端收起，默认）| 'black'（终端打开）| 'orange'（提问/授权，心跳闪烁）
// 状态同时写本地文件（客户端 Nim 读文件，避免主循环 HTTP 网络调用——
// 实测 net 模块 send/recv 在 Windows 触发 0xc0000005 访问冲突崩溃）
// 路径动态化（2026-08-16 主定稿）：写 Windows 用户目录根 pet-state.json，
// 客户端 Nim 用 %USERPROFILE% 读同一位置——不再硬编码用户名/路径，换机可部署
let petState = { pet: 'blue' };
function winUserHome() {
  // WSL 里解析 Windows 用户目录：/mnt/c/Users/<用户名>/（只取目录、排除系统内置与隐藏）
  try {
    const users = '/mnt/c/Users';
    const entries = fs.readdirSync(users, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') &&
        !['Public', 'Default', 'Default User', 'All Users'].includes(d.name))
      .map((d) => d.name);
    return entries.length > 0 ? '/mnt/c/Users/' + entries[0] + '/' : null;
  } catch (e) {
    return null;
  }
}
const PET_STATE_FILE = (winUserHome() || '/mnt/c/Users/') + 'pet-state.json';
function writePetStateFile() {
  try {
    fs.writeFileSync(PET_STATE_FILE, JSON.stringify(petState), 'utf8');
  } catch (e) {
    console.log('[term] pet-state file write failed:', e.message);
  }
}
// ---------- 终端状态持久化（设置/几何存服务端文件，跨重启保留） ----------
// 背景：WebView2 缓存目录（webui 随机/固定问题）不可靠，主 2026-08-16 定稿——
// 设置与面板几何存 WSL 服务端文件，插件启动读、改动写，彻底持久
const TERM_STATE_FILE = path.join(__dirname, 'term-state.json');
app.get('/api/term-state', (req, res) => {
  try {
    const data = fs.readFileSync(TERM_STATE_FILE, 'utf8');
    res.json(JSON.parse(data));
  } catch (e) {
    res.json(null);   // 首次/异常 → 默认
  }
});
app.post('/api/term-state', (req, res) => {
  try {
    fs.writeFileSync(TERM_STATE_FILE, JSON.stringify(req.body || {}), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/pet-state', (req, res) => res.json(petState));
app.post('/api/pet-state', (req, res) => {
  const pet = req.body && req.body.pet;
  if (pet !== 'blue' && pet !== 'black' && pet !== 'orange') {
    return res.status(400).json({ error: 'pet must be blue|black|orange' });
  }
  petState = { pet };
  writePetStateFile();
  res.json(petState);
});
// ---------- 横杠大纲历史持久化（服务端文件，跨重启保留） ----------
// 主 2026-08-17 定稿：横杠记录要"关机也能找回来"，走服务端文件（localStorage 在
// WebView2 缓存目录下不可靠）。按会话 ID 存 [{text}] 列表；插件启动读、来一条写一条。
const OUTLINE_HISTORY_FILE = path.join(__dirname, 'outline-history.json');
app.get('/api/outline-history', (req, res) => {
  const sid = req.query.sessionId || '';
  if (!sid) return res.status(400).json({ error: 'sessionId required' });
  try {
    const data = JSON.parse(fs.readFileSync(OUTLINE_HISTORY_FILE, 'utf8'));
    res.json({ list: Array.isArray(data[sid]) ? data[sid] : [] });
  } catch (e) {
    res.json({ list: [] });   // 首次/异常 → 空
  }
});
app.post('/api/outline-history', (req, res) => {
  try {
    const sid = req.body.sessionId;
    const list = req.body.list;
    if (!sid || !Array.isArray(list)) return res.status(400).json({ error: 'sessionId and list array required' });
    let data = {};
    try { data = JSON.parse(fs.readFileSync(OUTLINE_HISTORY_FILE, 'utf8')); } catch (e) {}
    data[sid] = list;
    fs.writeFileSync(OUTLINE_HISTORY_FILE, JSON.stringify(data), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// 提问检测（权威源）：会话记录 approval/asked vs decided，
// 有未决提问 → orange；否则 blue（黑/蓝由客户端本地按窗口状态决定）。
// 前端事件通道（subscribeEnvelopes）是诊断用途收不到业务事件，改后端检测。
// 事件驱动（2026-08-16 主要求省资源）：fs.watch 监听会话目录，有写入才检测
// （防抖合并），静默期零检测零消耗；不再固定 2 秒轮询解压。
// 每次检测都写文件（不能只写"变化时"——服务重启内存重置 blue 后，旧文件
// orange 永不被覆盖，Nim 会一直读到橙色闪烁；2026-08-16 实测踩坑）
const { execFile } = require('child_process');
let askRunning = false;
let askPending = false;
function runAskDetection() {
  if (askRunning) { askPending = true; return; }   // 限流：进行中则排队一次
  askRunning = true;
  execFile('python3', [path.join(__dirname, 'ask-pending.py')], { timeout: 8000 }, (err, stdout) => {
    askRunning = false;
    if (!err) {
      try {
        const r = JSON.parse(stdout);
        petState = { pet: r.asking ? 'orange' : 'blue' };
        writePetStateFile();
      } catch (e) { /* 解析失败保持现状 */ }
    }
    if (askPending) { askPending = false; runAskDetection(); }
  });
}
try {
  // 事件驱动：会话写入（含 approval/asked|decided）→ 立即检测（限流）
  fs.watch(path.join(os.homedir(), '.dsh/sessions'), { recursive: true }, () => runAskDetection());
} catch (e) { /* watch 失败则仅启动检测 */ }
runAskDetection();                                    // 启动立即检测一次（同步文件）

// ---------- 今日词元统计（聚合 dsh 会话记录，前端事件流不可靠，改后端算） ----------
// 异步聚合（execFileSync 会阻塞事件循环 20+ 秒，终端 WS 卡顿，不可用）
let todayUsageCache = { at: 0, data: null };
let todayUsageBusy = false;
function refreshTodayUsage() {
  if (todayUsageBusy) return;
  todayUsageBusy = true;
  execFile('python3', [path.join(__dirname, 'today-usage.py')], { timeout: 30000 }, (err, stdout) => {
    todayUsageBusy = false;
    if (err) return;
    try {
      todayUsageCache = { at: Date.now(), data: JSON.parse(stdout) };
    } catch (e) { /* 解析失败保持旧缓存 */ }
  });
}
refreshTodayUsage();                          // 启动立即聚合一次（HUB 不显示 aggregating）
setInterval(refreshTodayUsage, 60000);   // 后台 60 秒刷新一次
app.get('/api/today-usage', (req, res) => {
  if (todayUsageCache.data) {
    res.json(todayUsageCache.data);
  } else {
    res.json({ input: 0, output: 0, cacheRead: 0, note: 'aggregating' });
  }
  refreshTodayUsage();   // 异步触发聚合（下次请求拿到新值）
});
app.get('/api/balance', (req, res) => {
  if (balanceCache.data && Date.now() - balanceCache.at < 120000) {
    return res.json(balanceCache.data);
  }
  const key = readDeepSeekKey();
  if (!key) return res.status(500).json({ error: 'no DEEPSEEK_API_KEY' });
  const req2 = https.request({
    host: 'api.deepseek.com',
    path: '/user/balance',
    method: 'GET',
    headers: { Authorization: 'Bearer ' + key },
    timeout: 8000,
  }, (resp) => {
    let body = '';
    resp.on('data', (c) => { body += c; });
    resp.on('end', () => {
      try {
        const data = JSON.parse(body);
        balanceCache = { at: Date.now(), data };
        res.json(data);
      } catch (e) {
        res.status(502).json({ error: 'bad upstream response' });
      }
    });
  });
  req2.on('error', () => res.status(502).json({ error: 'upstream error' }));
  req2.on('timeout', () => { req2.destroy(); });
  req2.end();
});

// ---------- dsh 版本检测（2026-08-19 主要求：有新版时前端提示） ----------
// ⚠️ DEMO_MODE = 演示模式（给主演示提示条/更新流程）：模拟有新版 rc.8、点更新跳过真实安装。
//    恢复真实逻辑：DEMO_MODE 改 false，/api/dsh-version 走 30min 缓存 npm 查询，/api/dsh-update 走真实 npm install。
const DEMO_MODE = false;  // 已恢复真实逻辑（2026-08-19 主验收演示后关闭）
let dshVerCache = { at: 0, data: null };
const DSH_LOCAL_PKG = '/home/dream/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json';
function refreshDshVersion() {
  let local = null;
  try {
    local = require(DSH_LOCAL_PKG).version;
  } catch (e) {
    try {
      local = require('child_process').execSync('/home/dream/.npm-global/bin/dsh --version', { timeout: 5000 }).toString().trim() || null;
    } catch (e2) {}
  }
  const finish = (latest) => {
    dshVerCache = { at: Date.now(), data: { local, latest, hasUpdate: !!(local && latest && local !== latest) } };
  };
  const req = https.request({ host: 'registry.npmjs.org', path: '/@deepseek-ai/dsh/latest', method: 'GET', timeout: 8000 }, (resp) => {
    let body = '';
    resp.on('data', (c) => { body += c; });
    resp.on('end', () => {
      try { const d = JSON.parse(body); finish(d.version || null); } catch (e) { finish(null); }
    });
  });
  req.on('error', () => finish(null));
  req.on('timeout', () => req.destroy());
  req.end();
}
app.get('/api/dsh-version', (req, res) => {
  if (DEMO_MODE) return res.json({ local: '0.1.0-rc.7', latest: '0.1.0-rc.9-demo', hasUpdate: true });
  if (!dshVerCache.data || Date.now() - dshVerCache.at > 30 * 60 * 1000) refreshDshVersion();
  res.json(dshVerCache.data || { local: null, latest: null, hasUpdate: false, note: 'checking' });
});

// ---------- dsh 一键更新（2026-08-19 主要求：提示条点「更新」即执行） ----------
app.post('/api/dsh-update', (req, res) => {
  // 演示模式：跳过真实安装，直接返回成功（主 2026-08-19 要求：演示流程不真更新）
  if (DEMO_MODE) return res.json({ ok: true, local: '0.1.0-rc.9-demo', restarted: false });
  const { execFile } = require('child_process');
  execFile('/usr/bin/npm', ['install', '-g', '@deepseek-ai/dsh', '--cache', '/tmp/npm-cache-dsh-update'], { timeout: 180000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ ok: false, error: String(stderr || stdout || err).slice(0, 400) });
    dshVerCache = { at: 0, data: null };  // 清缓存，下次重新读新版本
    execFile('sudo', ['-n', 'systemctl', 'restart', 'dsh-web'], { timeout: 30000 }, (err2) => {
      let local = null;
      try { local = require('/home/dream/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json').version; } catch (e) {}
      res.json({ ok: true, local, restarted: !err2 });
    });
  });
});

// ---------- 平台用量代理（Token HUB 六项数据源：输入命中/未命中/输出/今日消耗） ----------
// 2026-08-17 主定稿：余额走官方 API（/api/balance），其余走 DeepSeek 开放平台
// 私有用量接口（platform.deepseek.com/api/v0/usage/amount|cost，需网页登录 token）。
// 干跑实测：必须带浏览器特征头（UA/Origin/Referer），否则平台 WAF 拦截（Request Blocked）。
// 返回结构：amount 的 biz_data 是对象 {total, days}；cost 的 biz_data 是数组
// [{total, days, currency}]（取 [0]）。days 为当月逐日明细，date 形如 "2026-08-17"，
// 每格 data 按模型给 usage 数组，type 枚举：
//   PROMPT_CACHE_HIT_TOKEN=输入(命中) / PROMPT_CACHE_MISS_TOKEN=输入(未命中)
//   / RESPONSE_TOKEN=输出 / REQUEST=请求次数；amount 是 token 数，cost 是金额（元，字符串）。
const PLATFORM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PLATFORM_ORIGIN = 'https://platform.deepseek.com';

function readPlatformToken() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'platform-token.json'), 'utf8'));
    return j.userToken || null;
  } catch (e) { return null; }
}

function platformGet(apiPath) {
  const token = readPlatformToken();
  if (!token) return Promise.reject(new Error('no platform token'));
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'platform.deepseek.com',
      path: apiPath,
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        'User-Agent': PLATFORM_UA,
        Origin: PLATFORM_ORIGIN,
        Referer: PLATFORM_ORIGIN + '/',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      timeout: 10000,
    }, (resp) => {
      let body = '';
      resp.on('data', (c) => { body += c; });
      resp.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad json from platform')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

function localDateStr(ms = Date.now()) {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function sumUsageType(dayData, type) {
  let s = 0;
  for (const m of (dayData || [])) {
    for (const u of (m.usage || [])) {
      if (u.type === type) s += parseFloat(u.amount) || 0;
    }
  }
  return s;
}

function findDayData(days, dateStr) {
  const hit = (days || []).find((x) => x.date === dateStr);
  return hit ? hit.data : null;
}

let platformUsageCache = { at: 0, data: null, error: null };
let platformUsageBusy = false;

function refreshPlatformUsage() {
  if (platformUsageBusy) return;
  platformUsageBusy = true;
  const now = new Date();
  const q = `?month=${now.getMonth() + 1}&year=${now.getFullYear()}`;
  Promise.all([
    platformGet('/api/v0/usage/amount' + q),
    platformGet('/api/v0/usage/cost' + q),
  ]).then(([amount, cost]) => {
    const aBiz = amount && amount.data && amount.data.biz_data;
    const cBizRaw = cost && cost.data && cost.data.biz_data;
    const cBiz = Array.isArray(cBizRaw) ? (cBizRaw[0] || {}) : (cBizRaw || {});
    const today = localDateStr();
    const aData = findDayData(aBiz ? aBiz.days : null, today);
    const cData = findDayData(cBiz.days, today);
    const hit = sumUsageType(aData, 'PROMPT_CACHE_HIT_TOKEN');
    const miss = sumUsageType(aData, 'PROMPT_CACHE_MISS_TOKEN');
    // 金额按类型拆分（cost 接口同 type 枚举，HUD 三列：名称/数据/金额）
    const hitCost = sumUsageType(cData, 'PROMPT_CACHE_HIT_TOKEN');
    const missCost = sumUsageType(cData, 'PROMPT_CACHE_MISS_TOKEN');
    const outCost = sumUsageType(cData, 'RESPONSE_TOKEN');
    platformUsageCache = {
      at: Date.now(),
      data: {
        source: 'platform',
        date: today,
        inputHit: hit,
        inputHitCost: hitCost,
        inputMiss: miss,
        inputMissCost: missCost,
        output: sumUsageType(aData, 'RESPONSE_TOKEN'),
        outputCost: outCost,
        requests: sumUsageType(aData, 'REQUEST'),
        cost: hitCost + missCost + outCost,
        costCurrency: cBiz.currency || 'CNY',
      },
      error: null,
    };
  }).catch((e) => {
    platformUsageCache = { at: Date.now(), data: null, error: String(e && e.message || e) };
  }).finally(() => { platformUsageBusy = false; });
}
refreshPlatformUsage();
setInterval(refreshPlatformUsage, 60000);
app.get('/api/platform-usage', (req, res) => {
  if (platformUsageCache.data && Date.now() - platformUsageCache.at < 60000) {
    return res.json(platformUsageCache.data);
  }
  if (!platformUsageBusy) refreshPlatformUsage();
  if (platformUsageCache.data) return res.json(platformUsageCache.data);  // 旧值先给
  res.status(503).json({ error: platformUsageCache.error || 'aggregating', fallback: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// 终端会话：ws 连接建立时 spawn bash，断开时销毁
wss.on('connection', (ws) => {
  const term = pty.spawn(process.env.SHELL || 'bash', [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: os.homedir(),
    env: Object.assign({}, process.env, { TERM: 'xterm-256color' }),
  });
  console.log(`[term] connected, pid=${term.pid}`);

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  term.onExit(({ exitCode }) => {
    console.log(`[term] exit pid=${term.pid} code=${exitCode}`);
    ws.close();
  });

  ws.on('message', (msg) => {
    const data = String(msg);
    // resize 指令（NUL 前缀避免与终端输入冲突）：\x00resize:{cols}:{rows}
    const rm = data.match(/^\x00resize:(\d+):(\d+)$/);
    if (rm) {
      term.resize(parseInt(rm[1], 10), parseInt(rm[2], 10));
      return;
    }
    term.write(data);
  });

  ws.on('close', () => {
    term.kill();
  });
  ws.on('error', () => {
    term.kill();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[dsh-terminal] listening on http://${HOST}:${PORT} (pid=${process.pid})`);
});
