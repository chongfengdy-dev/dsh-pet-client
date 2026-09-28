#!/usr/bin/env python3
# dsh-term-panels 配套：统计今日会话 token 消耗（输入/输出/缓存命中）
# 精确口径：按每条记录的时间戳（time 字段，毫秒）过滤今日，非按文件 mtime
import os, re, json, datetime
import zstandard

SESS_ROOT = os.path.expanduser('~/.dsh/sessions')

def today_start_ms():
    now = datetime.datetime.now()
    return int(datetime.datetime(now.year, now.month, now.day).timestamp() * 1000)

def scan():
    total = {'input': 0, 'output': 0, 'cacheRead': 0}
    start_ms = today_start_ms()
    if not os.path.isdir(SESS_ROOT):
        return total
    seen = set()
    for scope in os.listdir(SESS_ROOT):
        sp = os.path.join(SESS_ROOT, scope)
        if not os.path.isdir(sp):
            continue
        for sid in os.listdir(sp):
            # 会话日志改名历史：session.jsonl.zstd → v3（0.1.5）→ v4（0.1.7）。
            # 2026-09-28：按新→旧顺序取第一个存在的（v4 是完整文件，含全部历史，不会漏算）。
            f = None
            for _fn in ('session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd'):
                _p = os.path.join(sp, sid, _fn)
                if os.path.isfile(_p):
                    f = _p
                    break
            if f is None:
                continue
            try:
                # 2026-09-10：只解压今天动过的会话（全量 270+ 个文件要 46s，超时被杀）
                if os.path.getmtime(f) * 1000 < start_ms:
                    continue
            except OSError:
                continue
            try:
                d = zstandard.ZstdDecompressor()
                with open(f, 'rb') as fh:
                    with d.stream_reader(fh) as r:
                        buf = b''
                        while True:
                            chunk = r.read(1 << 20)
                            if not chunk:
                                break
                            buf += chunk
                            while b'\n' in buf:
                                line, buf = buf.split(b'\n', 1)
                                tm = re.search(rb'"time":(\d+)', line)
                                if not tm:
                                    continue
                                if int(tm.group(1)) < start_ms:
                                    continue
                                m = re.search(rb'"usage":\{[^}]*\}', line)
                                if not m:
                                    continue
                                key = m.group(0)
                                if key in seen:
                                    continue
                                seen.add(key)
                                s = key.decode('utf-8', 'replace')
                                def g(k):
                                    mm = re.search(k + r'":(\d+)', s)
                                    return int(mm.group(1)) if mm else 0
                                total['input'] += g('inputTokens')
                                total['output'] += g('outputTokens')
                                total['cacheRead'] += g('cacheReadTokens')
            except Exception:
                continue
    return total

if __name__ == '__main__':
    print(json.dumps(scan()))
