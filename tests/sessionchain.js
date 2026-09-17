const vm = require('vm'), fs = require('fs'), assert = require('assert');
const R = (f) => fs.readFileSync('extension/' + f, 'utf8');
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FUT = Math.floor(Date.now() / 1000) + 3600;
const SID = '01a0aaba-a8e4-7db3-bf1c-c2f6fcd6f7bc';
const RUN = 'run_abc123XYZ456';

const SESSJWT = b64u({alg:'none'}) + '.' + b64u({sub:'u1', pub:true, scopes:['read:sessions:'+SID,'write:sessions:'+SID], iss:'https://id.trigger.dev', aud:'https://api.trigger.dev', exp:FUT, iat:FUT-3600}) + '.' + b64u('sig');
const RUNJWT = b64u({alg:'none'}) + '.' + b64u({sub:'u1', pub:true, scopes:['read:runs:'+RUN,'read:sessions:'+SID], iss:'https://id.trigger.dev', aud:'https://api.trigger.dev', exp:FUT, iat:FUT-3600}) + '.' + b64u('sig');
const SID2 = '01a0ab89-13bf-7853-bed3-dbda2e3ba5d5';
const SESSJWT2 = b64u({alg:'none'}) + '.' + b64u({sub:'u1', pub:true, scopes:['read:sessions:'+SID2,'write:sessions:'+SID2], iss:'https://id.trigger.dev', aud:'https://api.trigger.dev', exp:FUT, iat:FUT-3600}) + '.' + b64u('sig');
const RUN2 = 'run_new999AAA';
const RUNJWT2 = b64u({alg:'none'}) + '.' + b64u({sub:'u1', pub:true, scopes:['read:runs:'+RUN2], exp:FUT, iat:FUT-3600}) + '.' + b64u('sig');

const EVENTS = JSON.stringify({events:[{id:'s1',text:'accounts/fireworks/models/qwen3p8-27b',icon:'tabler-cube'},{id:'s2',text:'8.5k',icon:'tabler-hash'}]});
const EVENTS2 = JSON.stringify({events:[{id:'s1',text:'accounts/google/models/gemini-3.8-flash',icon:'tabler-cube'}]});
const recordsWith = (tok) => JSON.stringify({records:[
  {data:{type:'start',messageId:'m1'},id:'a',seqNum:0},
  {data:{type:'text-delta',text:'hi'},id:'b',seqNum:1},
  {data:'',id:'',seqNum:2,headers:[['trigger-control','turn-complete'],['public-access-token',tok]]},
]});
const recordsEmpty = JSON.stringify({records:[{data:{type:'start',messageId:'m1'},id:'a',seqNum:0}]});

let INJECTED = '';
const sharedStore = {};
const chatWrites = [];
async function boot() {
  const store = new Proxy(sharedStore, {
    set(t, k, v) {
      t[k] = v;
      if (k === 'currentChat' && v && typeof v === 'object') {
        try { chatWrites.push(JSON.parse(JSON.stringify(v))); } catch (e) {}
      }
      return true;
    },
  });
  const sb = { URL: URL, location: { href: 'https://arena.ai/agent/xxx' },
    window: null,
    document: { querySelectorAll: () => [], body: {}, title: '',
      documentElement: { outerHTML: '', getAttribute: () => null, setAttribute: () => {}, appendChild: () => {} },
      createElement: () => ({ set textContent(v){ INJECTED += v; }, get textContent(){ return ''; }, remove(){} }),
      getElementById: () => null, head: null },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}, console: console,
    chrome: { storage: { local: {
      set: async (o) => Object.assign(store, o),
      get: async (ks) => Object.fromEntries((Array.isArray(ks) ? ks : [ks]).map((k) => [k, store[k]])) },
      onChanged: { addListener(){} } },
      runtime: { onMessage: { addListener(){} }, sendMessage: async () => ({}), getURL: (p) => p } },
    fetch: async () => ({ text: async () => '' }) };
  const bootEvs = [];
  sb.window = { addEventListener: (t, fn) => { sb['boot_' + t] = fn; }, dispatchEvent: (e) => { bootEvs.push(e); try { const fn = sb['boot_' + e.type]; if (fn) fn(e); } catch (err) {} return true; }, top: null, self: null };
  sb.window.self = sb.window; sb.window.top = sb.window;
  sb.CustomEvent = class { constructor(t, o){ this.type = t; this.detail = (o && o.detail) || {}; } };
  sb.MutationObserver = class { observe(){} disconnect(){} };
  vm.createContext(sb);
  for (const f of ['ext.js','model-utils.js','evidence.js','detector.js','models-scan.js','badge.js','content.js']) vm.runInContext(R(f), sb);
  await sleep(120);
  return sb;
}

// 页面上下文：fetch 按 URL 路由；timers 队列化（settle 驱动）
function pageWorld(route) {
  const evs = [];
  const timers = [];
  const intervals = [];
  const enc = new TextEncoder();
  const body = (s, ct) => {
    const ch = [enc.encode(s)];
    return { ok: true, headers: { get: () => ct },
      clone: () => ({ body: { getReader: () => { let i = 0; return { read: async () => (i < ch.length ? { done:false, value:ch[i++] } : { done:true }), cancel(){} }; } }, text: async () => s }),
      text: async () => s };
  };
  const sb = { document: { documentElement: { getAttribute: () => '[]' } }, MutationObserver: class { observe(){} },
    CustomEvent: class { constructor(t,o){ this.type=t; this.detail=(o&&o.detail)||{}; } },
    XMLHttpRequest: function(){}, Date: Date, JSON: JSON, Set: Set, TextDecoder: TextDecoder, Uint8Array: Uint8Array,
    atob: atob, console: console, setInterval: () => 0, clearInterval: () => {},
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    setInterval: (fn) => { intervals.push(fn); return intervals.length; }, clearInterval: () => {},
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    location: { href: 'https://arena.ai/agent/' + SID } };
  sb.window = { addEventListener: (t, fn) => { sb['on' + t] = fn; }, dispatchEvent: (e) => { evs.push(e); try { const fn = sb['on' + e.type]; if (fn) fn(e); } catch (err) {} return true; },
    fetch: (url) => Promise.resolve(route(String(url), body)), EventSource: function(){}, WebSocket: function(){} };
  const ctx = vm.createContext(sb);
  vm.runInContext('var window = this.window; var document = this.document; var location = this.location;', ctx);
  vm.runInContext(INJECTED, ctx);
  vm.runInContext('var fetch = window.fetch;', ctx);
  const stats = () => evs.filter((e) => e.type === 'knowmodel-snoop-stats').pop().detail.run;
  const settle = async (rounds) => { for (let k = 0; k < rounds; k++) { const q = timers.splice(0); q.forEach((f) => { try { f(); } catch (e) {} }); intervals.slice().forEach((f) => { try { f(); } catch (e) {} }); await sleep(60); } };
  return { ctx, evs, stats, settle };
}

(async () => {
  INJECTED = '';
  await boot();
  assert.ok(INJECTED.includes('fetchSessionRun'), 'payload 有新链');
  console.log('0 inject: PASS');

  // A. 全链：trigger-token 专线 → records 排水分发 → events → run-model
  {
    const w = pageWorld((url, body) => {
      if (url.includes('trigger-token') || url.includes('me/pulse')) return body(JSON.stringify({token: SESSJWT}), 'application/json');
      if (url.includes('/out/records')) return body(recordsWith(RUNJWT), 'application/json');
      if (url.includes('/runs/')) return body(EVENTS, 'application/json');
      return body('{}', 'application/json');
    });
    await vm.runInContext('fetch("https://arena.ai/api/chat/trigger-token").then(r=>r.text())', w.ctx);
    await w.settle(4);
    const st = w.stats();
    assert.ok(st.hasToken, 'A 会话已接受: ' + JSON.stringify({sess:st.sess, runId:st.runId, found:st.found, error:st.error}));
    assert.strictEqual(st.sess, SID.slice(0, 8), 'A 会话 uuid 前缀');
    const rm = w.evs.find((e) => e.type === 'knowmodel-run-model');
    assert.ok(rm && rm.detail.name === 'accounts/fireworks/models/qwen3p8-27b', 'A 链路到模型名: ' + JSON.stringify(rm && rm.detail));
    assert.strictEqual(rm.detail.runId, RUN, 'A 排水分发出 run');
    assert.strictEqual(st.error, 'armed', 'A 回哨兵态: ' + st.error);
    console.log('A session->records->events->model: PASS');
  }

  // B. 旧路 intact：runs 权限 token 直接走 events
  {
    const w = pageWorld((url, body) => {
      if (url.includes('/runs/')) return body(EVENTS, 'application/json');
      return body('{}', 'application/json');
    });
    await vm.runInContext(`window.dispatchEvent(new CustomEvent('knowmodel-run-token-seed',{detail:{token:'${RUNJWT}'}}))`, w.ctx);
    await w.settle(3);
    const rm = w.evs.find((e) => e.type === 'knowmodel-run-model');
    assert.ok(rm && rm.detail.runId === RUN, 'B 旧路直达: ' + JSON.stringify(rm && rm.detail));
    console.log('B legacy runs-token direct: PASS');
  }

  // C. 本轮未 complete：2s 重排，3 次拿不到停 no-run-yet
  {
    const w = pageWorld((url, body) => {
      if (url.includes('/out/records')) return body(recordsEmpty, 'application/json');
      return body('{}', 'application/json');
    });
    await vm.runInContext(`window.dispatchEvent(new CustomEvent('knowmodel-run-token-seed',{detail:{token:'${SESSJWT}'}}))`, w.ctx);
    await w.settle(6);
    const st = w.stats();
    assert.strictEqual(st.error, 'waiting-run', 'C 慢轮不断链: ' + JSON.stringify({error:st.error, fetches:st.fetches}));
    assert.ok(st.fetches >= 3, 'C 排过 3 次');
    assert.ok(st.hasToken, 'C 会话保持');
    console.log('C waiting-run slow poll: PASS');
  }

  // D. 非正门 URL 的 {"token": JWT} 照抓（通用 JSON 键名）
  {
    const w = pageWorld((url, body) => {
      if (url.includes('/api/other')) return body(JSON.stringify({token: SESSJWT}), 'application/json');
      if (url.includes('/out/records')) return body(recordsWith(RUNJWT), 'application/json');
      if (url.includes('/runs/')) return body(EVENTS, 'application/json');
      return body('{}', 'application/json');
    });
    await vm.runInContext('fetch("https://arena.ai/api/other").then(r=>r.text())', w.ctx);
    await w.settle(4);
    assert.ok(w.stats().hasToken, 'D 通用键名命中');
    console.log('D generic {"token"} capture: PASS');
  }

  // E. 新会话 token 清掉旧 runId（防 403 循环），并切到新 run
  {
    const w = pageWorld((url, body) => {
      if (url.includes('/out/records')) return body(recordsWith(RUNJWT2), 'application/json');
      if (url.includes('/runs/')) return body(EVENTS, 'application/json');
      return body('{}', 'application/json');
    });
    await vm.runInContext(`window.dispatchEvent(new CustomEvent('knowmodel-run-token-seed',{detail:{token:'${RUNJWT}'}}))`, w.ctx);
    // 同步 acceptToken 后旧 run 就位（settle 后会被哨兵态清空——那是设计）
    assert.strictEqual(w.stats().runId, RUN, 'E 先有旧 run');
    await w.settle(3);
    await vm.runInContext(`window.dispatchEvent(new CustomEvent('knowmodel-run-token-seed',{detail:{token:'${SESSJWT}'}}))`, w.ctx);
    await w.settle(4);
    const evsE = w.evs.filter((e) => e.type === 'knowmodel-run-model');
    assert.ok(evsE.length >= 2 && evsE[evsE.length - 1].detail.runId === RUN2, 'E 旧 runId 已清并切新 run: ' + JSON.stringify(evsE.map((e) => e.detail.runId)));
    console.log('E stale runId cleared on session token: PASS');
  }

  // F. 过期 token → 终局自救：正门换新会话 token → 全链走通
  {
    const EXPIRED = b64u({alg:'none'}) + '.' + b64u({sub:'u1', pub:true, scopes:['read:sessions:'+SID], exp:1000, iat:500}) + '.' + b64u('sig');
    const w = pageWorld((url, body) => {
      if (url.includes('trigger-token') || url.includes('me/pulse')) return body(JSON.stringify({token: SESSJWT}), 'application/json');
      if (url.includes('/out/records')) return body(recordsWith(RUNJWT), 'application/json');
      if (url.includes('/runs/')) return body(EVENTS, 'application/json');
      return body('{}', 'application/json');
    });
    await vm.runInContext(`window.dispatchEvent(new CustomEvent('knowmodel-run-token-seed',{detail:{token:'${EXPIRED}'}}))`, w.ctx);
    await w.settle(5);
    const rm = w.evs.find((e) => e.type === 'knowmodel-run-model');
    assert.ok(rm && rm.detail.name === 'accounts/fireworks/models/qwen3p8-27b', 'F 过期自救到模型: ' + JSON.stringify(rm && rm.detail));
        console.log('F expired token rejected then self-heal: PASS');
  }

  // H. 过期 run 残留种子（旧对话 SSR 死 token）被拒收 → 槽位空闲 → 自取新鲜会话 → 全链
  {
    const EXPRUN = b64u({alg:'none'}) + '.' + b64u({sub:'u9', pub:true, scopes:['read:runs:run_dead0000000000000000000001'], exp:1000, iat:500}) + '.' + b64u('sig');
    const w = pageWorld((url, body) => {
      if (url.includes('trigger-token') || url.includes('me/pulse')) return body(JSON.stringify({token: SESSJWT}), 'application/json');
      if (url.includes('/out/records')) return body(recordsWith(RUNJWT), 'application/json');
      if (url.includes('/runs/')) return body(EVENTS, 'application/json');
      return body('{}', 'application/json');
    });
    await vm.runInContext(`window.dispatchEvent(new CustomEvent('knowmodel-run-token-seed',{detail:{token:'${EXPRUN}'}}))`, w.ctx);
    await w.settle(5);
    const rm = w.evs.find((e) => e.type === 'knowmodel-run-model');
    assert.ok(rm && rm.detail.runId === RUN, 'H 死种子被拒、新链走通: ' + JSON.stringify(rm && rm.detail));
    assert.ok(w.stats().error === '' || w.stats().error === 'armed', 'H 无残留错误(armed=哨兵属正常): ' + w.stats().error);
    console.log('H expired run seed rejected, fresh chain: PASS');
  }

  // G. 空对话慢轮等待 → 用户发话 turn-complete 出现 → 模型
  {
    let hasTurn = false;
    const w = pageWorld((url, body) => {
      if (url.includes('/out/records')) { return body(hasTurn ? recordsWith(RUNJWT) : recordsEmpty, 'application/json'); }
      if (url.includes('/runs/')) return body(EVENTS, 'application/json');
      return body('{}', 'application/json');
    });
    await vm.runInContext(`window.dispatchEvent(new CustomEvent('knowmodel-run-token-seed',{detail:{token:'${SESSJWT}'}}))`, w.ctx);
    let seen = '';
    for (let k = 0; k < 8 && seen !== 'waiting-run'; k++) { await w.settle(1); seen = w.stats().error; }
    assert.strictEqual(seen, 'waiting-run', 'G 空对话等待中: ' + seen);
    hasTurn = true;
    await w.settle(4);
    const rm = w.evs.find((e) => e.type === 'knowmodel-run-model');
    assert.ok(rm && rm.detail.runId === RUN, 'G 发话后捕获: ' + JSON.stringify(rm && rm.detail));
        console.log('G empty chat waits then captures: PASS');
  }

  // I. 请求头携带（新站形态）：SPA 不调正门，直接 Bearer 打开 /out SSE → 扩展从请求头收 token → 全链
  {
    const w = pageWorld((url, body) => {
      if (url.includes('/out/records')) return body(recordsWith(RUNJWT), 'application/json');
      if (url.includes('/runs/')) return body(EVENTS, 'application/json');
      return body('{}', 'application/json');
    });
    await vm.runInContext(
      "fetch('https://arena.ai/ai-proxy/realtime/v1/sessions/' + " + JSON.stringify(SID) + " + '/out', {headers: {Authorization: 'Bearer ' + " + JSON.stringify(SESSJWT) + "}})",
      w.ctx);
    await w.settle(5);
    const rm = w.evs.find((e) => e.type === 'knowmodel-run-model');
    assert.ok(rm && rm.detail.name === 'accounts/fireworks/models/qwen3p8-27b', 'I 请求头捕获到模型: ' + JSON.stringify(rm && rm.detail));
    assert.ok(w.stats().hasToken, 'I 请求头 token 已收');
    console.log('I request-header carrier capture: PASS');
  }

  // J. 头里的随机 JWT（无 runs/sessions 权限）不占槽
  {
    const FOREIGN = b64u({alg:'none'}) + '.' + b64u({sub:'x', iss:'https://accounts.google.com', aud:'gcp'}) + '.' + b64u('sig');
    // 隔离路由：正门也发不了 token，唯一可能占槽的就是外来 JWT。
    const w = pageWorld((url, body) => body('{}', 'application/json'));
    await vm.runInContext(
      "fetch('/rpc/telemetry', {headers: {Authorization: 'Bearer ' + " + JSON.stringify(FOREIGN) + "}})",
      w.ctx);
    await w.settle(3);
    assert.ok(!w.stats().hasToken, 'J 外来 JWT 未占槽: ' + JSON.stringify(w.stats()));
    assert.ok((w.stats().reqHdrs || []).some((h) => h.tok === 'Authorization'), 'J 头已记录（证据在案）');
    console.log('J foreign JWT rejected: PASS');
  }

  // K. 新正门 pulse：SPA 打 /api/me/pulse，响应 {"token": SESSJWT} → 全链
  {
    const w = pageWorld((url, body) => {
      if (url.includes('me/pulse')) return body(JSON.stringify({token: SESSJWT, ok: true}), 'application/json');
      if (url.includes('/out/records')) return body(recordsWith(RUNJWT), 'application/json');
      if (url.includes('/runs/')) return body(EVENTS, 'application/json');
      return body('{}', 'application/json');
    });
    await vm.runInContext("fetch('/api/me/pulse').then(r=>r.text())", w.ctx);
    await w.settle(5);
    const rm = w.evs.find((e) => e.type === 'knowmodel-run-model');
    assert.ok(rm && rm.detail.name === 'accounts/fireworks/models/qwen3p8-27b', 'K pulse 正门捕获到模型: ' + JSON.stringify(rm && rm.detail));
    console.log('K pulse-gate capture: PASS');
  }

  // L. 二元数组格式 headers（SPA fetch 包装器实测形态）
  {
    const w = pageWorld((url, body) => {
      if (url.includes('/out/records')) return body(recordsWith(RUNJWT), 'application/json');
      if (url.includes('/runs/')) return body(EVENTS, 'application/json');
      return body('{}', 'application/json');
    });
    await vm.runInContext(
      "fetch('https://arena.ai/ai-proxy/realtime/v1/sessions/' + " + JSON.stringify(SID) + " + '/out', {headers: [['Authorization', 'Bearer ' + " + JSON.stringify(SESSJWT) + "], ['Accept', 'text/event-stream']]})",
      w.ctx);
    await w.settle(5);
    const rm = w.evs.find((e) => e.type === 'knowmodel-run-model');
    assert.ok(rm && rm.detail.name === 'accounts/fireworks/models/qwen3p8-27b', 'L 二元数组头捕获: ' + JSON.stringify(rm && rm.detail));
    assert.ok((w.stats().reqHdrs || []).some((h) => h.tok === 'Authorization' && /authorization/.test(h.hn)), 'L 头名解析出真名: ' + JSON.stringify(w.stats().reqHdrs));
    console.log('L pair-array headers parsed: PASS');
  }

  // M. 长轮活性：records 的 seqNum 一直涨（agent 在干活）不掐表，turn-complete 迟到也接得住
  {
    let calls = 0;
    const w = pageWorld((url, body) => {
      if (url.includes('/out/records')) {
        calls++;
        if (calls < 12) return body(JSON.stringify({records:[{data:{type:'text-delta'},id:'r'+calls,seqNum:calls}]}), 'application/json');
        return body(recordsWith(RUNJWT), 'application/json');
      }
      if (url.includes('/runs/')) return body(EVENTS, 'application/json');
      return body('{}', 'application/json');
    });
    await vm.runInContext("fetch('https://arena.ai/ai-proxy/realtime/v1/sessions/'+ " + JSON.stringify(SID) + "+'/out', {headers:{Authorization:'Bearer '+ " + JSON.stringify(SESSJWT) + "}})", w.ctx);
    await w.settle(14);
    const rm = w.evs.find((e) => e.type === 'knowmodel-run-model');
    assert.ok(rm && rm.detail.name === 'accounts/fireworks/models/qwen3p8-27b', 'M 长轮迟到 turn-complete: ' + JSON.stringify(rm && rm.detail));
    console.log('M live-run keeps polling: PASS');
  }

  // N. 空对话慢轮不死：30 次预算耗尽仍 waiting-run，等来消息照接
  {
    let armed = false;
    const w = pageWorld((url, body) => {
      if (url.includes('/out/records')) return armed ? body(recordsWith(RUNJWT), 'application/json') : body('{"records":[]}', 'application/json');
      if (url.includes('/runs/')) return body(EVENTS, 'application/json');
      return body('{}', 'application/json');
    });
    await vm.runInContext("fetch('https://arena.ai/ai-proxy/realtime/v1/sessions/'+ " + JSON.stringify(SID) + "+'/out', {headers:{Authorization:'Bearer '+ " + JSON.stringify(SESSJWT) + "}})", w.ctx);
    await w.settle(33);
    assert.strictEqual(w.stats().error, 'waiting-run', 'N 慢轮仍等待: ' + w.stats().error);
    armed = true;
    await w.settle(4);
    const rm = w.evs.find((e) => e.type === 'knowmodel-run-model');
    assert.ok(rm, 'N 等来 turn-complete 接住: ' + JSON.stringify(w.stats()));
    console.log('N slow-poll never dies: PASS');
  }

  // O. 每轮换模型：第一轮 → 模型A（且只派发一次）；append 触发第二轮 → 模型B
  {
    let phase = 0;
    const w = pageWorld((url, body) => {
      if (url.includes('/out/records')) return body(phase === 0 ? recordsWith(RUNJWT) : recordsWith(RUNJWT2), 'application/json');
      if (url.includes(RUN2)) return body(EVENTS2, 'application/json');
      if (url.includes('/runs/')) return body(EVENTS, 'application/json');
      return body('{}', 'application/json');
    });
    await vm.runInContext("fetch('https://arena.ai/ai-proxy/realtime/v1/sessions/'+ " + JSON.stringify(SID) + "+'/out', {headers:{Authorization:'Bearer '+ " + JSON.stringify(SESSJWT) + "}})", w.ctx);
    await w.settle(5);
    const evs1 = w.evs.filter((e) => e.type === 'knowmodel-run-model');
    assert.strictEqual(evs1.length, 1, 'O 第一轮只派发一次: ' + evs1.length + ' ' + JSON.stringify(evs1.map((e) => e.detail.runId)));
    assert.strictEqual(evs1[0].detail.name, 'accounts/fireworks/models/qwen3p8-27b');
    assert.strictEqual(w.stats().error, 'armed', 'O 哨兵态: ' + w.stats().error);
    phase = 1;
    await vm.runInContext("fetch('/ai-proxy/realtime/v1/sessions/'+ " + JSON.stringify(SID) + "+'/in/append', {method:'POST', headers:{Authorization:'Bearer '+ " + JSON.stringify(SESSJWT) + "}})", w.ctx);
    await w.settle(5);
    const evs2 = w.evs.filter((e) => e.type === 'knowmodel-run-model');
    assert.ok(evs2.length >= 2, 'O 第二轮有新派发: ' + evs2.length);
    assert.strictEqual(evs2[evs2.length - 1].detail.name, 'accounts/google/models/gemini-3.8-flash', 'O 第二轮换模型: ' + JSON.stringify(evs2.map((e) => e.detail.name)));
    assert.strictEqual(w.stats().error, 'armed', 'O 二轮后回哨兵态: ' + w.stats().error);
    console.log('O per-turn model switch: PASS');
  }

  // P. 占槽不死锁：槽里有 token 时，SPA 新鲜正门响应（不同会话）必须能换进来
  {
    const w = pageWorld((url, body) => {
      if (url.includes('trigger-token')) return body(JSON.stringify({token: SESSJWT2}), 'application/json');
      if (url.includes('/out/records')) return body(recordsEmpty, 'application/json');
      if (url.includes('/runs/')) return body(EVENTS, 'application/json');
      return body('{}', 'application/json');
    });
    await vm.runInContext("fetch('https://arena.ai/ai-proxy/realtime/v1/sessions/' + " + JSON.stringify(SID) + " + '/out', {headers:{Authorization:'Bearer '+ " + JSON.stringify(SESSJWT) + "}})", w.ctx);
    await w.settle(2);
    assert.ok(w.stats().hasToken && w.stats().sess === SID.slice(0, 8), 'P 先占槽: ' + JSON.stringify(w.stats()));
    await vm.runInContext("fetch('/api/chat/trigger-token').then(r=>r.text())", w.ctx);
    await w.settle(4);
    const st = w.stats();
    assert.strictEqual(st.sess, SID2.slice(0, 8), 'P 新鲜正门 token 换进来了: ' + JSON.stringify({sess: st.sess, accepts: st.accepts}));
    assert.ok((st.accepts || []).some((a) => a.src === 'resp:trig'), 'P 来源=resp:trig: ' + JSON.stringify(st.accepts));
    console.log('P stale-slot fresh-token swap: PASS');
  }

  // AD. 融合落盘（内容世界真调用）：run.trace 证据 + updateCurrentChat →
  // 定案 resolved 落盘，旧形状字段保留。
  // 注：内容脚本是 IIFE，内部函数不外露；经页面事件缝驱动整条管线。
  {
    const b = await boot();
    const runInBoot = (src) => vm.runInContext(src, b);
    sharedStore.models = [{ publicName: 'Qwen3P8-27B', organization: 'fireworks', id: 'accounts/fireworks/models/qwen3p8-27b', capabilities: { outputCapabilities: { text: true } } }];
    // 页面事件 → 内容脚本监听 → 进池（knowmodel-evidence），与真实页面同路
    runInBoot(`window.__kmpTest.evidence([{ source: 'run.trace.model', weight: 1.00, modelId: 'accounts/fireworks/models/qwen3p8-27b', detail: 'run run_AD' }])`);
    // 证据进池只是"原料"：内容脚本的轻/深扫描（updateCurrentChat）在测试沙盒里
    // 读不到 DOM，无结论可融合。本段直接走融合落盘入口断言判定数学与落盘形状。
    const cc = await runInBoot(`window.__kmpTest.fuse({ mode: 'direct', revealed: false, models: [{ publicName: 'accounts/fireworks/models/qwen3p8-27b', organization: '', id: 'trace:AD', capabilities: [] }], source: 'run-trace', url: 'https://arena.ai/agent/AD', updatedAt: Date.now() })`);
    assert.ok(cc && cc.kind === 'resolved' && cc.confidence >= 0.9, 'AD 融合定案: ' + JSON.stringify(cc && {kind: cc.kind, confidence: cc.confidence, source: cc.source}));
    assert.ok(Array.isArray(cc.evidence) && cc.evidence.some((e) => e.source === 'run.trace.model'), 'AD 证据有 trace');
    assert.ok(cc.url && cc.updatedAt && cc.mode, 'AD 旧形状保留: ' + JSON.stringify({mode: cc.mode, source: cc.source}));
    console.log('AD fused verdict stored: PASS');
  }

  // AE. 档案回填（内容世界真调用）：run-trace 源 fuseAndEmit → 定案写入档案
  {
    const b = await boot();
    const runInBoot = (src) => vm.runInContext(src, b);
    delete sharedStore.knowmodelLearned;
    // run-trace 落盘经 knowmodel-run-model 事件（内容脚本 onRunModel 真监听）
    runInBoot(`window.__kmpTest.runModel('accounts/fireworks/models/qwen3p8-27b', 'run_AE')`);
    await sleep(50);
    const learned = sharedStore.knowmodelLearned;
    const has = learned && learned.entries && learned.entries.some((e) => e.verified && (e.modelIds || []).some((m) => /qwen3p8-27b/.test(m)));
    assert.ok(has, 'AE 定案写入档案: ' + JSON.stringify(learned && learned.entries && learned.entries.length));
    const cc = sharedStore.currentChat;
    assert.ok(cc && cc.kind === 'resolved', 'AE 落盘定案: ' + JSON.stringify(cc && cc.kind));
    console.log('AE archive backfill: PASS');
  }

  // AF. 推断路径：无证据 → unknown 但形状完整、不崩（经同一 fuse 入口）
  {
    const b = await boot();
    const runInBoot = (src) => vm.runInContext(src, b);
    await runInBoot(`window.__kmpTest.fuse({ mode: 'unknown', revealed: false, models: [], source: 'none', url: 'https://arena.ai/', updatedAt: Date.now() })`);
    const cc = sharedStore.currentChat;
    assert.ok(cc && typeof cc.kind === 'string' && Array.isArray(cc.evidence), 'AF 形状安全: ' + JSON.stringify(cc && {kind: cc.kind, ev: cc.evidence && cc.evidence.length}));
    console.log('AF inferred-path safe: PASS');
  }
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
