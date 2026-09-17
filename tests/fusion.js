'use strict';
// 纯逻辑层回归（Q 起）：融合引擎 / 代号解析 / 协议指纹 / 行为探针 / 学习档案。
// 缝：KMP_FUSION / KMP_LEARNED 纯函数（不碰扩展 API、不碰 DOM），
// 直接在 VM 里加载 extension/evidence.js 后断言判定结果。
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const R = (f) => fs.readFileSync('extension/' + f, 'utf8');
const sb = { console };
vm.createContext(sb);
vm.runInContext(R('evidence.js'), sb);
const F = sb.KMP_FUSION;
const L = sb.KMP_LEARNED;
assert.ok(F && L, 'KMP_FUSION/KMP_LEARNED 已加载');

// Q. 强证据聚合 → 定案，多源加成封顶 0.99
{
  const v = F.classify([
    { source: 'run.trace.model', weight: 1.00, modelId: 'accounts/fireworks/models/qwen3p8-27b' },
    { source: 'idmap.resolve', weight: 0.92, modelId: 'accounts/fireworks/models/qwen3p8-27b' },
  ]);
  assert.strictEqual(v.mode, 'RESOLVED', 'Q 定案: ' + JSON.stringify(v));
  assert.ok(v.confidence >= 0.99, 'Q 置信度封顶: ' + v.confidence);
  assert.strictEqual(v.family, 'qwen', 'Q 家族: ' + v.family);
  console.log('Q resolved aggregation: PASS');
}

// R. 只有家族证据 → 推断，只报家族不报版本
{
  const v = F.classify([
    { source: 'url.host.vendor', weight: 0.85, family: 'deepseek', detail: 'api.deepseek.com' },
  ]);
  assert.strictEqual(v.mode, 'INFERRED', 'R 推断: ' + JSON.stringify(v));
  assert.strictEqual(v.modelId, null, 'R 不报具体模型');
  assert.ok(/家族/.test(v.label), 'R 标签诚实: ' + v.label);
  console.log('R inferred family only: PASS');
}

// S. 只有传输层证据 → 未知，绝不拿协议冒充家族（qwen 报 openai 74.1% 的教训）
{
  const v = F.classify([
    { source: 'traffic.sniff', weight: 0.60, family: '__realtime_batch', detail: 'event: batch' },
    { source: 'traffic.sniff', weight: 0.55, family: '__sdk_wire', detail: 'text-delta' },
  ]);
  assert.strictEqual(v.mode, 'UNKNOWN', 'S 未知: ' + JSON.stringify(v));
  assert.strictEqual(v.family, null, 'S 家族必须为空');
  assert.ok(v.wireLabel, 'S 给出传输层说明: ' + v.wireLabel);
  console.log('S wire-only stays unknown: PASS');
}

// T. 代号解析：匿名槽 / 参数量 / 日期快照 / 家族 / 代际
{
  const a = F.parseCodename('model-a');
  assert.ok(a.anonymous, 'T 匿名槽: ' + JSON.stringify(a));
  const b = F.parseCodename('accounts/fireworks/models/qwen3p8-27b-20260801');
  assert.strictEqual(b.family, 'qwen', 'T 家族');
  assert.ok(b.hints.some((h) => /27B/.test(h)), 'T 参数量: ' + b.hints);
  assert.ok(b.hints.some((h) => /2026-08-01/.test(h)), 'T 日期快照: ' + b.hints);
  const c = F.parseCodename('gpt-6-turbo');
  assert.strictEqual(c.family, 'openai', 'T openai');
  assert.ok(c.version && c.version.major === 6, 'T 代际: ' + JSON.stringify(c.version));
  const d = F.parseCodename('claude-opus-4-5-max');
  assert.ok(d.hints.some((h) => /档位/.test(h)), 'T 档位: ' + d.hints);
  console.log('T codename parsing: PASS');
}

// U. 协议指纹：anthropic 帧 vs SDK 传输帧 vs 转义引号
{
  const anth = '{"type":"message_start","message":{"id":"msg_1"}}\n{"type":"content_block_delta","delta":{"text":"hi"}}\ntoolu_abc123';
  const h1 = F.protocolFingerprint(anth);
  assert.ok(h1.length && h1[0].family === 'anthropic', 'U anthropic: ' + JSON.stringify(h1.map((h) => h.family)));
  const sdk = '{"type":"start"}\n{"type":"text-delta","delta":"hi"}\n{"type":"finish","finishReason":"stop"}';
  const h2 = F.protocolFingerprint(sdk);
  assert.ok(h2.length && h2[0].family === '__sdk_wire', 'U SDK 传输层不判家族: ' + JSON.stringify(h2.map((h) => h.family)));
  const esc = '{\"type\":\"start\",\"x\":1} tail {\"seq_num\":5}';
  const h3 = F.protocolFingerprint(esc);
  assert.ok(h3.some((h) => h.family === '__sdk_wire'), 'U 转义引号可判: ' + JSON.stringify(h3.map((h) => h.family)));
  console.log('U protocol fingerprint: PASS');
}

// V. 单条共用字段命中按 60% 折算
{
  const h = F.protocolFingerprint('{"reasoning_content":"..."}');
  const hit = h.filter((x) => x.family !== '__sse_generic')[0];
  assert.ok(hit && hit.score <= 0.5, 'V 单测折减: ' + JSON.stringify(h));
  console.log('V single-test discount: PASS');
}

// W. 主机 → 厂商；网关标 __ 前缀
{
  assert.strictEqual(F.vendorOfHost('https://api.deepseek.com/chat').family, 'deepseek', 'W deepseek');
  assert.strictEqual(F.vendorOfHost('https://api.fireworks.ai/x').family, '__gateway:fireworks', 'W 网关');
  assert.strictEqual(F.vendorOfHost('https://arena.ai/x'), null, 'W 未知主机');
  console.log('W host vendor: PASS');
}

// X. canary 分析：拒答风格 / 截止 / 自报 / 字形
{
  const r = F.runCanaries("I'm sorry, I can't help with that. As an AI developed by OpenAI...");
  assert.ok(r.some((e) => e.family === 'openai' && e.source === 'behavior.probe'), 'X 拒答: ' + JSON.stringify(r));
  const c = F.runCanaries('我的知识截止到2026年3月。');
  assert.ok(c.some((e) => /2025/.test(e.detail)), 'X 截止: ' + JSON.stringify(c));
  const i = F.runCanaries('Claude Opus 4.5');
  assert.ok(i.some((e) => e.source === 'self.report' && e.modelId), 'X 自报: ' + JSON.stringify(i));
  const t = F.runCanaries('龘\n鱻\n麤\n馫\n灥\n飍\n雥\n馕');
  assert.ok(t.some((e) => /8\/8|7\/8/.test(e.detail)), 'X 字形: ' + JSON.stringify(t));
  console.log('X canary analysis: PASS');
}

// Y. 发送门：默认关；节流/冲突/路由变化全挡
{
  assert.strictEqual(F.shouldSendProbe({}).ok, false, 'Y 默认关');
  assert.strictEqual(F.shouldSendProbe({ armed: true, editorCount: 1, routeStable: true, now: 100 }).ok, true, 'Y 放行');
  assert.strictEqual(F.shouldSendProbe({ armed: true, editorCount: 1, routeStable: true, now: 100, lastSentAt: 95 }).ok, false, 'Y 10s 节流');
  assert.strictEqual(F.shouldSendProbe({ armed: true, editorCount: 2, routeStable: true, now: 100 }).ok, false, 'Y 输入框不唯一');
  assert.strictEqual(F.shouldSendProbe({ armed: true, editorCount: 1, routeStable: true, now: 100, draftConflict: true }).ok, false, 'Y 草稿冲突');
  assert.strictEqual(F.shouldSendProbe({ armed: true, editorCount: 1, routeStable: false, now: 100 }).ok, false, 'Y 路由变化');
  console.log('Y probe gate: PASS');
}

// Z. 学习档案：UNSEEN 建档 → 同向量命中 → 定案写入 → 回填
{
  L.setStore(L.memStore());
  const v1 = L.learnFromObservation({ text: '{"model":"zzz-new-9b-20260901"}' }, [{ source: 'response.json.model', weight: 0.93, modelId: 'zzz-new-9b-20260901' }]);
  assert.ok(v1.kind === 'NEW_MODEL' && v1.entry.status === 'UNSEEN', 'Z 建档: ' + JSON.stringify(v1.kind));
  const v2 = L.learnFromObservation({ text: '{"model":"zzz-new-9b-20260901"}' }, [{ source: 'response.json.model', weight: 0.93, modelId: 'zzz-new-9b-20260901' }]);
  assert.strictEqual(v2.kind, 'MATCH', 'Z 同源命中: ' + v2.kind);
  const w = L.recordRealModel('zzz-neverseen-9b-202609', { runId: 'run_X' });
  assert.ok(w.entry.verified && w.entry.status === 'VERIFIED_UNLISTED', 'Z 定案写入: ' + JSON.stringify(w.entry.status));
  assert.ok(L.findByModelId('zzz-neverseen-9b-202609'), 'Z 按 id 命中');
  const w2 = L.recordRealModel('accounts/fireworks/models/qwen3p8-27b', { runId: 'run_Y' });
  assert.strictEqual(w2.entry.status, 'KNOWN', 'Z 目录内定案: ' + w2.entry.status);
  L.setStore(L.memStore());
  L.learnFromObservation({ text: 'hi' }, []);
  const db = L.listLearned();
  db[db.length - 1].modelIds.push('claude-5-sonnet-x');
  const n = L.backfillNames();
  assert.strictEqual(n, 1, 'Z 溯名条数: ' + n);
  const st = L.stats();
  assert.ok(st.entries >= 1, 'Z 统计: ' + JSON.stringify(st));
  const ex = L.exportLearned();
  L.setStore(L.memStore());
  assert.ok(L.importLearned(ex), 'Z 导入');
  assert.strictEqual(L.listLearned().length, st.entries, 'Z 导出导入对等');
  L.clearLearned();
  assert.strictEqual(L.listLearned().length, 0, 'Z 清除');
  console.log('Z learning archive: PASS');
}

// AA. 判定组装：同 URL 定案不被推断降级；新定案可替换
{
  const prev = { url: 'u1', kind: 'resolved', confidence: 0.99, models: [{ publicName: 'Q' }], source: 'run-trace', family: 'qwen', verdictLabel: 'Q', evidence: [] };
  const kept = F.assemblePayload(prev, { url: 'u1', mode: 'direct', models: [], source: 'none' }, { mode: 'INFERRED', family: 'qwen', confidence: 0.6, label: 'qwen 家族', evidence: [] });
  assert.ok(kept.keptPrev && kept.models[0].publicName === 'Q', 'AA 护旧: ' + JSON.stringify(kept.keptPrev));
  const repl = F.assemblePayload(prev, { url: 'u1', mode: 'direct', models: [{ publicName: 'G' }], source: 'run-trace' }, { mode: 'RESOLVED', modelId: 'G', confidence: 0.99, label: 'G', evidence: [] });
  assert.ok(!repl.keptPrev && repl.models[0].publicName === 'G', 'AA 替换');
  console.log('AA payload assembly: PASS');
}

// AB. 响应头证据：model 头 0.95；Map/对象两形态
{
  const ev = F.evidenceFromHeaders({ 'x-model': 'gpt-6-astra', 'content-type': 'application/json' }, 'u');
  assert.ok(ev.some((e) => e.source === 'response.header.model' && e.weight === 0.95), 'AB model 头: ' + JSON.stringify(ev));
  const ev2 = F.evidenceFromHeaders(new Map([['x-provider', 'anthropic']]), 'u');
  assert.ok(ev2.some((e) => e.family === 'anthropic'), 'AB provider 头: ' + JSON.stringify(ev2));
  console.log('AB header evidence: PASS');
}

// AC. 余弦相似度：相同=1，空=0
{
  const a = F.fingerprintVector({ text: '{"type":"message_start"} toolu_abc123' });
  assert.strictEqual(F.cosineSim(a, a), 1, 'AC 自相似');
  assert.strictEqual(F.cosineSim(a, {}), 0, 'AC 空向量');
  assert.ok(a.p_anthropic === 1 && a.has_toolu === 1, 'AC 维度: ' + JSON.stringify(a));
  console.log('AC cosine similarity: PASS');
}

// AD. 权威证据不因目录缺席降级：run.trace 1.00 的未收录名照样 RESOLVED（线上
// super_nova_ext 定案语义锁定：trace 说是谁就是谁，不查目录脸色）
{
  const v = F.classify([{ source: 'run.trace.model', weight: 1.00, modelId: 'super_nova_ext', detail: 'run run_x' }]);
  assert.strictEqual(v.mode, 'RESOLVED', 'AD 未收录权威名定案: ' + JSON.stringify({ mode: v.mode, conf: v.confidence }));
  assert.strictEqual(v.modelId, 'super_nova_ext', 'AD 名原样: ' + v.modelId);
  assert.ok(v.confidence >= 0.55, 'AD 置信度: ' + v.confidence);
  console.log('AD unlisted authority resolves: PASS');
}

// AE. 档案双源合并：verified 不被后来的未验证覆盖；runIds 并集；count 取大
{
  const a = { entries: [{ id: 'v_x', modelIds: ['m'], resolved: 'm', verified: true, status: 'VERIFIED_UNLISTED', count: 2, runIds: ['r1'], lastSeen: 10, firstSeen: 10 }] };
  const b = { entries: [{ id: 'v_x', modelIds: ['m'], resolved: 'm', verified: false, status: 'UNSEEN', count: 5, runIds: ['r2'], lastSeen: 20, firstSeen: 5 }] };
  const m = L.mergeDbs(a, b);
  assert.strictEqual(m.entries.length, 1, 'AE 去重');
  assert.ok(m.entries[0].verified && m.entries[0].status === 'VERIFIED_UNLISTED', 'AE 定案优先: ' + JSON.stringify({ v: m.entries[0].verified, s: m.entries[0].status }));
  assert.ok(m.entries[0].runIds.length === 2 && m.entries[0].count === 5 && m.entries[0].lastSeen === 20 && m.entries[0].firstSeen === 5, 'AE 合并: ' + JSON.stringify(m.entries[0]));
  console.log('AE archive merge: PASS');
}
