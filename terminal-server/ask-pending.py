#!/usr/bin/env python3
# 检测会话状态（主定稿 2026-08-16 橙闪；2026-08-21 新增回复完成绿闪）：
# 1. ask_user_question 提问未决（tool/call 精确匹配 name + callId 配对 + answered 集合防重试）
# 2. approval/asked 审批/授权请求未决（asked > decided，最近 10 分钟内）
# 3. 回复完成（2026-08-21 主需求：提问后 dsh 干完活绿闪提示）——
#    turn 配对：最后一个 turn/end(completed) 的 turn 内存在 user/message（用户提问触发的轮次）
#    → done=true, doneAt=turn/end 时间戳。自动任务（无 user/message）不误报。
# 时间窗：只认最近 10 分钟内的未决（历史遗留不提醒）
import os, re, json, time, zstandard

SESS_ROOT = os.path.expanduser('~/.dsh/sessions')
CALLID_RE = re.compile(rb'"callId":"([^"]+)"')
TIME_RE = re.compile(rb'"time":(\d+)')
ASK_WINDOW_MS = 10 * 60 * 1000   # 10 分钟窗口

def latest_session_file():
    best = None
    best_mt = 0
    if not os.path.isdir(SESS_ROOT):
        return None
    for scope in os.listdir(SESS_ROOT):
        sp = os.path.join(SESS_ROOT, scope)
        if not os.path.isdir(sp):
            continue
        for sid in os.listdir(sp):
            f = os.path.join(sp, sid, 'session.jsonl.zstd')
            if not os.path.isfile(f):
                continue
            mt = os.path.getmtime(f)
            if mt > best_mt:
                best_mt = mt
                best = f
    return best

def main():
    f = latest_session_file()
    if not f:
        print(json.dumps({'asking': False, 'done': False}))
        return
    now = int(time.time() * 1000)
    called = {}       # ask_user_question: callId -> 最近 call 时间
    answered = set()  # ask_user_question: 出现过 result → 已答
    ask_asked = ask_decided = 0   # approval 计数（10 分钟窗口内）
    # ---- 回复完成判定（turn 配对）----
    last_user_msg = None      # 最后 user/message 时间
    current_turn = None       # 当前进行中 turn 号（最近 turn/start）
    turn_has_user = {}        # turn 号 -> 该轮内是否有 user/message
    last_turn_end = None      # 最后一个 turn/end(completed): {turn, time}
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
                        if b'"name":"ask_user_question"' in line:
                            m = CALLID_RE.search(line)
                            if m:
                                tm = TIME_RE.search(line)
                                called[m.group(1)] = int(tm.group(1)) if tm else 0
                        elif b'"tool/result"' in line:
                            m = CALLID_RE.search(line)
                            if m:
                                answered.add(m.group(1))
                        elif b'"approval/asked"' in line:
                            tm = TIME_RE.search(line)
                            if tm and now - int(tm.group(1)) <= ASK_WINDOW_MS:
                                ask_asked += 1
                        elif b'"approval/decided"' in line:
                            tm = TIME_RE.search(line)
                            if tm and now - int(tm.group(1)) <= ASK_WINDOW_MS:
                                ask_decided += 1
                        elif b'"type":"turn/start"' in line:
                            m = re.search(rb'"turn":\s*"?(\d+)"?', line)
                            if m:
                                current_turn = int(m.group(1))
                                turn_has_user[current_turn] = False
                        elif b'"type":"user/message"' in line:
                            tm = TIME_RE.search(line)
                            if tm:
                                last_user_msg = int(tm.group(1))
                                if current_turn is not None:
                                    turn_has_user[current_turn] = True
                        elif b'"type":"turn/end"' in line:
                            m = re.search(rb'"turn":\s*"?(\d+)"?', line)
                            tm = TIME_RE.search(line)
                            if m and tm:
                                t = int(m.group(1))
                                # 只认 completed 结束（进行中/中断不算完成）
                                if b'"kind":"completed"' in line:
                                    last_turn_end = {'turn': t, 'time': int(tm.group(1))}
    except Exception:
        pass
    ask_pending = any((now - t) <= ASK_WINDOW_MS and cid not in answered
                      for cid, t in called.items())
    approval_pending = ask_asked > ask_decided
    # 回复完成：最后一个 turn/end(completed) 存在，其 turn 内有 user/message（用户提问触发），
    # 且该轮之后没有更新的 user/message（新提问未完成前不算旧轮完成）
    done = False
    done_at = None
    if last_turn_end is not None and turn_has_user.get(last_turn_end['turn'], False):
        t = last_turn_end['time']
        # 该轮结束后没有再发新的提问（最后 user/message 时间 < turn/end 时间）
        if last_user_msg is None or last_user_msg <= t:
            done = True
            done_at = t
    print(json.dumps({'asking': ask_pending or approval_pending, 'done': done,
                      'doneAt': done_at}))

if __name__ == '__main__':
    main()
