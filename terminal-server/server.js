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
app.use(express.json({ limit: '64kb' }));

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
