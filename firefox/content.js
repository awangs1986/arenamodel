/* 内容脚本（编排层）：模型列表抓取 + 当前对话识别 + 徽标 + 上报。
 * 重活下沉到各模块——KnowModelScan（列表提取）、KnowModelDetector（对话识别，
 * deep 模式追加"页面数据里的模型 id"扫描）、KnowModelBadge（右下角徽标）、
 * KnowModel（模型小工具）；嗅探载荷 snoopPayload 内联在本文件（函数 toString 注入
 * 页面上下文，无需再 fetch 自身资源——Firefox 下 fetch 扩展内文件曾报 NetworkError，
 * 内联后彻底规避）。本文件只做编排：种子目录补齐、定时抓取、DOM 变化去抖重检、
 * 网络命中合并、popup 刷新消息。
 * TEMP-DIAG：诊断快照 knowmodelDiag（定位 agent 页识别问题用，修好后删除）。
 */
'use strict';

(() => {
  // 本页抓到过 initialModels（首页/榜单）时，网络命中的 id 只是列表噪音，直接忽略。
  let listFoundOnPage = false;
  // 最近一次识别的存疑候选（页面数据命中 ≥3 个时），只进诊断不进结论。
  let lastCandidates = [];

  // TEMP-DIAG：诊断快照——只记 pipeline 状态与 opaque id，不含聊天正文。
  let diag = {
    url: location.href,
    title: document.title || '',
    verbose: false,
    seeded: false,
    events: [],
    net: { ready: false, idCount: 0, responses: 0, hits: 0, lastHitAt: 0, lastIds: [], lastUrl: '' },
    errors: [],
  };

  function log() {
    if (!diag.verbose) return;
    try {
      console.log.apply(console, ['[knowmodel]'].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {
      /* 控制台不可用时跳过 */
    }
  }

  function diagNote(err, where) {
    try {
      diag.errors.push({ t: Date.now(), where: where, msg: String((err && err.message) || err).slice(0, 160) });
      if (diag.errors.length > 10) diag.errors.shift();
    } catch (e) {
      /* 记账失败不影响主流程 */
    }
  }

  async function persistDiag() {
    try {
      await ext.storage.local.set({ knowmodelDiag: diag });
    } catch (e) {
      /* 存不下就算了 */
    }
  }

  async function getStoredModels() {
    try {
      const { models } = await ext.storage.local.get(['models']);
      return Array.isArray(models) ? models : [];
    } catch (e) {
      return [];
    }
  }

  function validCount(list) {
    return (list || []).filter(KnowModel.isValid).length;
  }

  function publishModelIds(list) {
    try {
      const ids = (list || []).map((m) => m && m.id).filter(Boolean);
      document.documentElement.setAttribute('data-knowmodel-ids', JSON.stringify(ids));
      log('publish ids:', ids.length);
    } catch (e) {
      diagNote(e, 'publishModelIds');
    }
  }

  // 缓存为空时（用户只开过 agent/对话页、没去过首页）：拉首页 HTML 解析目录自救。
  // 同源 fetch，主机权限本来就有，不新增权限。
  async function seedModelsIfEmpty() {
    try {
      const cur = await getStoredModels();
      if (cur.length) return cur;
      log('seed: cache empty, fetching homepage catalog');
      const res = await fetch('https://arena.ai/', { credentials: 'same-origin' });
      const html = await res.text();
      const found = KnowModelScan.scanModels({
        documentElement: { outerHTML: html },
        querySelectorAll: () => [],
      });
      if (found && found.length) {
        await ext.storage.local.set({ models: found, updatedAt: Date.now(), url: 'https://arena.ai/' });
        publishModelIds(found);
        diag.seeded = true;
        log('seed: got', found.length);
        try {
          await ext.runtime.sendMessage({ type: 'knowmodel-updated', count: validCount(found) });
        } catch (e) {
          /* 未监听时忽略 */
        }
        return found;
      }
      diagNote(new Error('seed: no catalog in homepage html'), 'seedModels');
    } catch (e) {
      diagNote(e, 'seedModels');
    }
    return [];
  }

  async function scanModels() {
    const found = KnowModelScan.scanModels(document);
    if (found && found.length) {
      listFoundOnPage = true;
      publishModelIds(found);
      await ext.storage.local.set({ models: found, updatedAt: Date.now(), url: location.href });
      try {
        await ext.runtime.sendMessage({ type: 'knowmodel-updated', count: validCount(found) });
      } catch (e) {
        /* popup/background 未监听时忽略 */
      }
    }
    return found;
  }

  function infoOf(m) {
    return {
      publicName: (m && m.publicName) || '',
      organization: (m && m.organization) || '',
      id: (m && m.id) || '',
      capabilities: KnowModel.caps(m),
    };
  }

  async function updateCurrentChat(deep, force) {
    try {
      const models = await getStoredModels();
      const st = KnowModelDetector.detect(location.href, document, models, { deep: !!deep });
      lastCandidates = ((st && st.candidates) || []).map((m) => (m && m.publicName) || '');
      let payload = {
        mode: st.mode,
        revealed: !!st.revealed,
        models: st.models || [],
        source: st.source || 'none',
        url: location.href,
        updatedAt: Date.now(),
      };
      // 同一 URL 下不降级：本轮没找到但之前已确认过模型（多为网络嗅探结论），
      // 保留旧结论只刷新时间；URL 变了则无条件接受新结论（SPA 切页不留旧数据）。
      // 手动刷新（force）绕过保护：用户点了刷新就是要重认，旧结论再可疑也得让位。
      try {
        const { currentChat: prev } = await ext.storage.local.get(['currentChat']);
        if (
          !force &&
          prev &&
          prev.url === payload.url &&
          !payload.models.length &&
          prev.models &&
          prev.models.length
        ) {
          payload = Object.assign({}, prev, { updatedAt: payload.updatedAt });
        }
      } catch (e) {
        /* 读不到旧结论就直接写新结论 */
      }
      await ext.storage.local.set({ currentChat: payload });
      KnowModelBadge.show(document, KnowModelBadge.textFor(payload));
      log('detect', deep ? 'deep' : 'light', payload.mode, payload.source);
      return payload;
    } catch (e) {
      diagNote(e, 'updateCurrentChat');
      return null;
    }
  }

  function pageStats(models) {
    try {
      if (KnowModelDetector.stats) return KnowModelDetector.stats(document, models);
    } catch (e) {
      diagNote(e, 'pageStats');
    }
    return null;
  }

  // 网络嗅探命中（嗅探载荷经 CustomEvent 传出）：首个命中即定论，不追加。
  // 对话的模型在加载时就确定，后到的响应多为次要内容（推荐/榜单），first-hit-wins
  // 避免长会话里攒出一堆噪音 id；全部候选仍记进诊断供定位。
  async function onNetHit(ev) {
    try {
      if (listFoundOnPage) return;
      const ids = (ev && ev.detail && ev.detail.ids) || [];
      if (!ids.length) return;
      const fromUrl = (ev && ev.detail && ev.detail.url) || '';
      log('net hit:', JSON.stringify(ids), 'from:', fromUrl.slice(0, 120));
      try {
        diag.net.lastUrl = String(fromUrl).slice(0, 200);
        await persistDiag();
      } catch (e) {
        /* 记账失败继续 */
      }
      let cur = null;
      try {
        ({ currentChat: cur } = await ext.storage.local.get(['currentChat']));
      } catch (e) {
        cur = null;
      }
      // 跨对话隔离：存的结论属于别的 URL（已经切了对话），本页从零开始，
      // 否则上一个对话的首命中会吞掉新对话的命中（first-hit-wins 误伤）。
      if (cur && cur.url && cur.url !== location.href) cur = null;
      // 运行轨迹结论最高权威：同 URL 下网络命中不得覆盖它。
      if (cur && cur.source === 'run-trace' && cur.models && cur.models.length) return;
      if (cur && cur.source === 'network' && cur.models && cur.models.length) return;
      const models = await getStoredModels();
      const byId = Object.create(null);
      for (const m of models) {
        if (m && m.id) byId[String(m.id).toLowerCase()] = m;
      }
      const have = Object.create(null);
      const merged = [];
      for (const m of (cur && cur.models) || []) {
        if (m && m.id && !have[m.id]) {
          have[m.id] = true;
          merged.push(m);
        }
      }
      for (const id of ids) {
        const m = byId[String(id).toLowerCase()];
        if (m && !have[m.id]) {
          have[m.id] = true;
          merged.push(infoOf(m));
        }
      }
      const prevCount = ((cur && cur.models) || []).length;
      if (!merged.length || merged.length === prevCount) return;
      const payload = {
        mode: merged.length === 1 ? 'direct' : 'battle',
        revealed: merged.length > 1,
        models: merged.slice(0, 2),
        source: 'network',
        url: location.href,
        updatedAt: Date.now(),
      };
      await ext.storage.local.set({ currentChat: payload });
      KnowModelBadge.show(document, KnowModelBadge.textFor(payload));
    } catch (e) {
      diagNote(e, 'onNetHit');
    }
  }

  // TEMP-DIAG：嗅探器状态上报（存活/扫了多少响应/命中几次）。
  function onSnoopStats(ev) {
    try {
      const d = (ev && ev.detail) || {};
      diag.net = {
        ready: true,
        idCount: d.idCount || 0,
        responses: d.responses || 0,
        hits: d.hits || 0,
        lastHitAt: d.lastHitAt || 0,
        lastIds: d.lastIds || [],
        lastUrl: d.lastUrl || diag.net.lastUrl || '',
        run: d.run || diag.net.run || null,
      };
      log('snoop stats:', JSON.stringify(diag.net));
      persistDiag();
    } catch (e) {
      diagNote(e, 'onSnoopStats');
    }
  }

  /* 嗅探载荷：在页面上下文执行（不能用扩展 API，只能读写 DOM）。
   * hook window.fetch 与 XHR，把 JSON 响应当 UUID token 扫描，只把命中的已知模型 id
   * 经 CustomEvent 传出去——对话正文不出页面上下文。已知 id 列表由内容脚本经
   * documentElement 的 data-knowmodel-ids 属性传入。
   * 注意：本函数经 toString() 序列化后注入，内部不得引用外层作用域任何变量。
   */
  function snoopPayload() {
    var ATTR = 'data-knowmodel-ids';
    var UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    var ids = new Set();
    var seen = new Set();
    var scanned = 0;
    var hitCount = 0;
    var lastHitAt = 0;
    var lastIds = [];
    var lastUrl = '';
    /* ---- 运行轨迹取证（思路学自 Arena模型助手探针的 runmodel 链，实现重写）----
     * agent 页响应流里不含模型名，但流的 records[].headers 会下发
     * public-access-token（JWT，scope 含 read:runs:<runId>）。拿它去读
     * Trigger.dev 上该 run 的 trace：ai.streamText.doStream span 里 icon 含
     * cube 的标签就是 worker 写入的真实模型名。全程只传 token/runId/模型名。 */
    var TRIGGER_API = 'https://api.trigger.dev';
    // 原版拦截器装了四路钩子：fetch / XHR / WebSocket / EventSource（installSocketHook）。
    // 我第一版只装了 fetch/XHR——agent 流若走 ES/WS 就全军覆没（实测 diag 就是
    // responses:0 且页面在跑）。现在补齐，并且 fetch 的门槛也按原版改成：
    // 流式 content-type 或无 content-type 就旁路，不再只认 URL。
    var JWT_SHAPE_RE = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
    var TOKEN_RE = /([A-Za-z0-9_.-]*access-token[A-Za-z0-9_.-]*)[^A-Za-z0-9_\-]+(eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)/i;
    var STREAM_URL_RE = /(stream|conversation|agent|chat|run|events|realtime|batch|\/api\/)/i;
    var STATIC_EXT_RE = /\.(?:js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map|mp4|webp|avif)(?:\?|$)/i;
    var STREAM_CT_RE = /text\/event-stream|application\/x-ndjson|application\/stream\+json|text\/plain/i;
    var run = { token: null, runId: null, exp: 0, fetches: 0, found: null, error: '', polling: false, timer: 0, tries: 0, taps: 0, sockMsgs: 0 };
    function b64url(s) {
      try {
        s = String(s).replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '=';
        return atob(s);
      } catch (e) { return ''; }
    }
    function runIdFromToken(token) {
      try {
        var parts = String(token).split('.');
        if (parts.length < 2) return null;
        var p = JSON.parse(b64url(parts[1]));
        if (!p) return null;
        var scopes = p.scopes || [];
        for (var i = 0; i < scopes.length; i++) {
          var m = String(scopes[i]).match(/(?:read|write):[A-Za-z]+:(run_[A-Za-z0-9]+)/);
          if (m) return m[1];
        }
        var m2 = JSON.stringify(p).match(/(run_[A-Za-z0-9]{10,})/);
        if (m2) return m2[1];
      } catch (e) {}
      return null;
    }
    function extractLabels(text) {
      var models = [];
      if (typeof text !== 'string' || !text) return models;
      var re = /"text"\s*:\s*"([^"]{1,80})"\s*,\s*"icon"\s*:\s*"([^"]{1,40})"/g;
      var m;
      while ((m = re.exec(text)) !== null) {
        if (m[2].indexOf('cube') >= 0) models.push(m[1]);
      }
      return models;
    }
    function findToken(text) {
      try {
        var m = TOKEN_RE.exec(text || '');
        return m ? m[2] : null;
      } catch (e) { return null; }
    }
    function stopPoll() {
      try { if (run.timer && typeof clearInterval === 'function') clearInterval(run.timer); } catch (e) {}
      run.timer = 0;
      run.polling = false;
    }
    function acceptToken(token) {
      if (!token || typeof token !== 'string') return;
      if (token === run.token) return;
      if (!JWT_SHAPE_RE.test(token)) return;
      var rid = runIdFromToken(token);
      var exp = 0;
      try {
        var p = JSON.parse(b64url(String(token).split('.')[1]));
        exp = (p && p.exp) || 0;
      } catch (e) {}
      stopPoll();
      run.token = token;
      // 原版：rid 解不出时保留旧 runId（同一 run 的续期 token 仍可用）。
      run.runId = rid || run.runId;
      run.exp = exp;
      run.fetches = 0;
      run.found = null;
      run.error = '';
      emitStats();
      startPoll();
    }
    function startPoll() {
      if (run.polling) return;
      run.polling = true;
      run.tries = 0;
      try { run.timer = setInterval(pollOnce, 6000); } catch (e) {}
      pollOnce();
    }
    function pollOnce() {
      run.tries++;
      var token = run.token, rid = run.runId;
      if (!token || !rid) { run.error = 'no-token'; stopPoll(); emitStats(); return; }
      // 同原版 fetchRunModels：过期就不再打了（早停，不耗到 30 次）。
      if (run.exp && Date.now() > run.exp * 1000) { run.error = 'token-expired'; stopPoll(); emitStats(); return; }
      run.fetches++;
      emitStats();
      // 同原版：20s AbortController 超时，跨域挂起也不至于永远卡住。
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
      var done = function () { try { clearTimeout(timer); } catch (e) {} };
      fetch(TRIGGER_API + '/api/v1/runs/' + rid + '/events', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
        credentials: 'omit',
        signal: ctrl ? ctrl.signal : undefined,
      }).then(function (res) {
        if (!res.ok) throw new Error('http-' + res.status);
        return res.text();
      }).then(function (text) {
        done();
        run.error = '';
        var labels = extractLabels(text);
        if (labels.length) {
          // 同原版：去重后取最后一个（最后一次调用的模型）。
          var uniq = [];
          for (var i = 0; i < labels.length; i++) if (uniq.indexOf(labels[i]) < 0) uniq.push(labels[i]);
          var name = uniq[uniq.length - 1];
          run.found = name;
          stopPoll();
          try {
            window.dispatchEvent(new CustomEvent('knowmodel-run-model', { detail: { name: name, runId: rid, all: uniq } }));
          } catch (e) {}
        } else if (run.tries >= 30) {
          run.error = 'timeout';
          stopPoll();
        }
        emitStats();
      }).catch(function (err) {
        done();
        var msg = String((err && err.name === 'AbortError') ? 'timeout-20s' : ((err && err.message) || err));
        run.error = msg.slice(0, 80);
        if (run.tries >= 30) stopPoll();
        emitStats();
      });
    }
    function watchStream(res, url) {
      run.taps++;
      emitStats(); // 让诊断区能看到“收到 N 条流”的进度，不至于以为没流量。
      // 渐进读 clone 分支找 token（token 在流开头 headers 帧，不能等流结束）。
      try {
        var reader = res.clone().body.getReader();
        var dec = new TextDecoder();
        var buf = '', bytes = 0, done = false;
        (function pump() {
          reader.read().then(function (r) {
            if (r.done || done) { try { reader.cancel(); } catch (e) {} return; }
            bytes += r.value ? r.value.length : 0;
            try { buf += dec.decode(r.value || new Uint8Array(0), { stream: true }); } catch (e) {}
            if (buf.length < 2 * 1024 * 1024) {
              var tk = findToken(buf);
              if (tk) { done = true; acceptToken(tk); try { reader.cancel(); } catch (e) {} return; }
            }
            if (bytes > 512 * 1024) { try { reader.cancel(); } catch (e) {} return; }
            pump();
          }).catch(function () {});
        })();
      } catch (e) {}
    }
    // 补全原版 installSocketHook：EventSource / WebSocket 逐条消息里找 token。
    // （fetch 钩子罩不到 ES/WS；实测 agent 页若不发 fetch 流，原版靠这两路兜底。）
    try {
      if (window.EventSource && !window.EventSource.__kmpWrapped) {
        var OE = window.EventSource;
        var E = function (url, cfg) {
          var es = new OE(url, cfg);
          try {
            es.addEventListener('message', function (ev) {
              run.sockMsgs++;
              // 消息频率可能高：每 10 条或拿到 token 时才刷一次统计。
              if (run.sockMsgs % 10 === 0 || !run.token) emitStats();
              var d = typeof ev.data === 'string' ? ev.data : '';
              if (!run.token && d) {
                var tk = findToken(d);
                if (tk) acceptToken(tk);
              }
            });
          } catch (e) {}
          return es;
        };
        E.prototype = OE.prototype;
        E.__kmpWrapped = true;
        window.EventSource = E;
      }
    } catch (e) {}
    try {
      if (window.WebSocket && !window.WebSocket.__kmpWrapped) {
        var OW = window.WebSocket;
        var W = function (url, protocols) {
          var ws = new OW(url, protocols);
          try {
            ws.addEventListener('message', function (ev) {
              run.sockMsgs++;
              // 消息频率可能高：每 10 条或拿到 token 时才刷一次统计。
              if (run.sockMsgs % 10 === 0 || !run.token) emitStats();
              var d = typeof ev.data === 'string' ? ev.data : '';
              if (!d && ev.data instanceof ArrayBuffer && typeof TextDecoder === 'function') {
                try { d = new TextDecoder().decode(ev.data); } catch (e2) { d = ''; }
              }
              if (!d && typeof Blob === 'function' && ev.data instanceof Blob) {
                try { ev.data.text().then(function (t) { if (!run.token) { var tk2 = findToken(t); if (tk2) acceptToken(tk2); } }).catch(function () {}); return; } catch (e2) {}
              }
              if (!run.token && d) {
                var tk = findToken(d);
                if (tk) acceptToken(tk);
              }
            });
          } catch (e) {}
          return ws;
        };
        W.prototype = OW.prototype;
        W.__kmpWrapped = true;
        window.WebSocket = W;
      }
    } catch (e) {}
    function loadIds() {
      try {
        var raw = document.documentElement.getAttribute(ATTR);
        var arr = raw ? JSON.parse(raw) : [];
        ids = new Set(
          (Array.isArray(arr) ? arr : []).map(function (x) {
            return String(x).toLowerCase();
          })
        );
      } catch (e) {
        ids = new Set();
      }
    }
    loadIds();
    try {
      new MutationObserver(loadIds).observe(document.documentElement, {
        attributes: true,
        attributeFilter: [ATTR],
      });
    } catch (e) {}
    function emitStats() {
      try {
        window.dispatchEvent(
          new CustomEvent('knowmodel-snoop-stats', {
            detail: {
              ready: true,
              idCount: ids.size,
              responses: scanned,
              hits: hitCount,
              lastHitAt: lastHitAt,
              lastIds: lastIds.slice(0, 4),
              lastUrl: lastUrl,
              run: { hasToken: !!run.token, runId: run.runId || '', fetches: run.fetches, found: run.found || '', error: run.error || '', taps: run.taps, sockMsgs: run.sockMsgs },
            },
          })
        );
      } catch (e) {}
    }
    function check(text, url) {
      if (!ids.size || !text || typeof text !== 'string') return;
      if (text.length > 4 * 1024 * 1024) return;
      scanned++;
      if (scanned % 25 === 0) emitStats();
      var hit = [];
      UUID_RE.lastIndex = 0;
      var m;
      while ((m = UUID_RE.exec(text)) !== null) {
        var id = m[0].toLowerCase();
        if (ids.has(id) && !seen.has(id)) {
          seen.add(id);
          hit.push(id);
        }
        if (hit.length >= 4) break;
      }
      if (hit.length) {
        hitCount += hit.length;
        lastHitAt = Date.now();
        lastIds = hit;
        lastUrl = String(url || '').slice(0, 200);
        window.dispatchEvent(
          new CustomEvent('knowmodel-net-hit', { detail: { ids: hit, url: lastUrl } })
        );
        emitStats();
      }
    }
    function looksLikeData(res) {
      try {
        var ct = String((res.headers && res.headers.get('content-type')) || '').toLowerCase();
        return ct.indexOf('json') !== -1 || ct.indexOf('text') !== -1 || ct.indexOf('flight') !== -1;
      } catch (e) {
        return false;
      }
    }
    function reqUrl(input) {
      try {
        if (typeof input === 'string') return input;
        if (input && input.url) return input.url;
      } catch (e) {}
      return '';
    }
    try {
      var origFetch = window.fetch;
      window.fetch = function (input) {
        var url = reqUrl(input);
        return origFetch.apply(this, arguments).then(function (res) {
          try {
            // 门槛学原版 shouldInspect：流式 CT / 无 CT / LLM 风格 URL 都旁路。
            var ct = '';
            try { ct = String((res.headers && res.headers.get('content-type')) || '').toLowerCase(); } catch (e2) {}
            var watchable = !STATIC_EXT_RE.test(url || '') && (STREAM_CT_RE.test(ct) || !ct || STREAM_URL_RE.test(url || ''));
            if (watchable) {
              try { watchStream(res, url); } catch (e3) {}
            }
            if (looksLikeData(res)) {
              res
                .clone()
                .text()
                .then(function (t) {
                  check(t, url);
                  if (!run.token) {
                    var tk = findToken(t);
                    if (tk) acceptToken(tk);
                  }
                })
                .catch(function () {});
            }
          } catch (e) {}
          return res;
        });
      };
    } catch (e) {}
    try {
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        try {
          // 流式 XHR：progress 增量里找 token，不等 load。
          xhr.addEventListener('progress', function () {
            try {
              if (!run.token && typeof xhr.responseText === 'string' && xhr.responseText.length < 2 * 1024 * 1024) {
                var tk = findToken(xhr.responseText);
                if (tk) acceptToken(tk);
              }
            } catch (e) {}
          });
          xhr.addEventListener('load', function () {
            try {
              if (typeof xhr.responseText === 'string') {
                check(xhr.responseText, xhr.responseURL);
                if (!run.token) {
                  var tk = findToken(xhr.responseText);
                  if (tk) acceptToken(tk);
                }
              }
            } catch (e) {}
          });
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
    } catch (e) {}
    // 内容脚本的种子 token / 切页重置经 CustomEvent 进来（页面世界单向收）。
    try {
      window.addEventListener('knowmodel-run-token-seed', function (ev) {
        try { acceptToken(ev && ev.detail && ev.detail.token); } catch (e) {}
      });
      window.addEventListener('knowmodel-nav-reset', function () {
        try {
          stopPoll();
          run.token = null;
          run.runId = null;
          run.exp = 0;
          run.fetches = 0;
          run.found = null;
          run.error = '';
          emitStats();
        } catch (e) {}
      });
    } catch (e) {}
    emitStats();
  }

  // 注入页面上下文的嗅探脚本：函数 toString 内联执行，不 fetch 自身资源（Firefox 曾因此失败）。
  // CSP 若拦截则静默降级，靠 deep 扫描兜底；5 秒没收到 ready 回报就记一笔以便区分。
  let snoopInjected = false;
  function ensureNetSnoop() {
    if (snoopInjected) return;
    snoopInjected = true;
    try {
      const src = '(' + snoopPayload.toString() + ')();';
      const el = document.createElement('script');
      el.textContent = src;
      (document.head || document.documentElement).appendChild(el);
      el.remove();
      log('snoop injected, src len:', src.length);
      setTimeout(() => {
        if (!diag.net.ready) {
          diagNote(new Error('no snoop ready after 5s (CSP?)'), 'ensureNetSnoop');
          persistDiag();
        }
      }, 5000);
    } catch (e) {
      diagNote(e, 'ensureNetSnoop');
    }
  }

  // 运行轨迹结论（最高权威）：trace 报出的真实模型名直接定论。名字若不在目录里
  // 也照样展示——trace 是 worker 自己写的，比目录全更重要。
  async function onRunModel(ev) {
    try {
      const name = norm((ev && ev.detail && ev.detail.name) || '');
      const runId = (ev && ev.detail && ev.detail.runId) || '';
      if (!name) return;
      log('run trace model:', name, runId);
      let cur = null;
      try {
        ({ currentChat: cur } = await ext.storage.local.get(['currentChat']));
      } catch (e) {
        cur = null;
      }
      if (cur && cur.url && cur.url !== location.href) cur = null;
      if (cur && cur.source === 'run-trace' && cur.models && cur.models.length &&
          cur.models[0].publicName === name) return;
      const models = await getStoredModels();
      let hit = null;
      const nl = name.toLowerCase();
      for (const m of models) {
        if (m && m.publicName && String(m.publicName).toLowerCase() === nl) { hit = m; break; }
      }
      const info = hit ? infoOf(hit) : { publicName: name, organization: '', id: 'trace:' + runId, capabilities: [] };
      const payload = {
        mode: 'direct',
        revealed: false,
        models: [info],
        source: 'run-trace',
        url: location.href,
        updatedAt: Date.now(),
      };
      await ext.storage.local.set({ currentChat: payload });
      KnowModelBadge.show(document, KnowModelBadge.textFor(payload));
      try {
        diag.lastRunName = name;
        diag.lastRunId = runId;
        await persistDiag();
      } catch (e) {
        /* 记账失败继续 */
      }
    } catch (e) {
      diagNote(e, 'onRunModel');
    }
  }

  function norm(s) {
    return String(s == null ? '' : s).trim();
  }

  // 页面 HTML 里残留的 token（历史流）：喂给页面世界走同一条取证管线。
  // 头名与 shape 判定跟页面世界同源（任何 *access-token 头 + eyJ JWT）。
  const TOKEN_RE = /(?:[A-Za-z0-9_.-]*access-token[A-Za-z0-9_.-]*)[^A-Za-z0-9_\-]+(eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)/i;
  function seedRunToken() {
    try {
      const html = (document.documentElement && document.documentElement.outerHTML) || '';
      const m = TOKEN_RE.exec(html.slice(0, 4 * 1024 * 1024));
      if (m && m[1]) {
        log('seed run token from page html');
        window.dispatchEvent(new CustomEvent('knowmodel-run-token-seed', { detail: { token: m[1] } }));
      }
    } catch (e) {
      diagNote(e, 'seedRunToken');
    }
  }

  function notifyPageNavReset() {
    try {
      window.dispatchEvent(new CustomEvent('knowmodel-nav-reset'));
    } catch (e) {
      /* 页面世界收不到就算了 */
    }
  }

  try {
    window.addEventListener('knowmodel-net-hit', onNetHit);
    window.addEventListener('knowmodel-snoop-stats', onSnoopStats);
    window.addEventListener('knowmodel-run-model', onRunModel);
  } catch (e) {
    /* 极端环境跳过 */
  }

  try {
    ext.storage.local.get(['knowmodelVerbose']).then((r) => {
      diag.verbose = !!(r && r.knowmodelVerbose);
    });
    ext.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes && changes.knowmodelVerbose) {
        diag.verbose = !!changes.knowmodelVerbose.newValue;
      }
    });
  } catch (e) {
    /* 读不到开关就保持关闭 */
  }

  async function fullScan(force) {
    let models = await scanModels();
    if (!models || !models.length) {
      // 无列表页（agent/对话页）：先用缓存 id 喂嗅探器；缓存也没有就拉首页自救
      const cached = await getStoredModels();
      if (cached.length) {
        publishModelIds(cached);
      } else {
        models = await seedModelsIfEmpty();
      }
    }
    ensureNetSnoop();
    seedRunToken();
    const chat = await updateCurrentChat(!models || !models.length, !!force);
    // TEMP-DIAG：记一笔 pipeline 快照
    try {
      diag.url = location.href;
      diag.title = document.title || '';
      diag.events.push({
        t: Date.now(),
        listFound: !!(models && models.length),
        seeded: diag.seeded,
        mode: chat && chat.mode,
        source: chat && chat.source,
        modelNames: ((chat && chat.models) || []).map((m) => m.publicName),
        candidates: lastCandidates.slice(0, 10),
        stats: pageStats(models && models.length ? models : await getStoredModels()),
      });
      if (diag.events.length > 20) diag.events.shift();
      await persistDiag();
    } catch (e) {
      diagNote(e, 'fullScan-diag');
    }
    return { models: models, chat: chat };
  }

  // 页面是 hydration 渐进渲染的：加载后轮询几次，直到抓到模型列表为止。
  // SPA 切路由不重载文档：地址变化监听器会重置状态并重新拉起扫描。
  let tries = 0;
  let lastHref = location.href;
  let scanTimer = null;

  async function tick() {
    tries++;
    const r = await fullScan();
    if ((r.models && r.models.length) || tries >= 12) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
  }

  function armScan() {
    if (scanTimer) return;
    scanTimer = setInterval(tick, 3000);
    tick();
  }

  armScan();
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      listFoundOnPage = false;
      tries = 0;
      // 切对话了：立刻清零旧结论，别让上一个对话的模型赖在屏幕上；
      // 新结论由随后几轮扫描（运行轨迹/网络首命中）填进来。页面世界的轮询也要停。
      notifyPageNavReset();
      try {
        const reset = { mode: 'unknown', revealed: false, models: [], source: 'none', url: lastHref, updatedAt: Date.now() };
        ext.storage.local.set({ currentChat: reset });
        KnowModelBadge.show(document, KnowModelBadge.textFor(reset));
      } catch (e) {
        diagNote(e, 'nav-reset');
      }
      diag.events.push({ t: Date.now(), nav: lastHref });
      persistDiag();
      armScan();
    }
  }, 2000);

  // 流式输出 / 投票揭晓都会改 DOM：去抖后重检对话状态（轻量检测，不重做 deep 扫描）
  let moTimer = null;
  try {
    const mo = new MutationObserver(() => {
      clearTimeout(moTimer);
      moTimer = setTimeout(() => updateCurrentChat(false, false), 1200);
    });
    mo.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  } catch (e) {
    /* 不支持则跳过，靠轮询和手动刷新兜底 */
  }

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'knowmodel-rescan') {
      fullScan(true).then((r) =>
        sendResponse({
          ok: !!(r.models && r.models.length),
          count: r.models ? validCount(r.models) : 0,
          total: r.models ? r.models.length : 0,
        })
      );
      return true;
    }
  });
})();
