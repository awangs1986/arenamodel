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
  /* 探针进化（#3–#7）：证据收集与融合。
   * 证据池按轮隔离（run.sess/run.runId 对照），纯判定数学在 evidence.js；
   * 这里只负责收证据、调 classify、写 storage。 */
  const evPool = [];
  function poolPush(ev) {
    try {
      if (!ev || typeof ev !== 'object') return;
      ev.sess = ((diag.net.run && diag.net.run.sess) || '');
      ev.runId = ((diag.net.run && diag.net.run.runId) || '');
      ev.t = Date.now();
      if (ev.weight == null) ev.weight = 0.5;
      evPool.push(ev);
      if (evPool.length > 60) evPool.splice(0, evPool.length - 60);
    } catch (eP) {}
  }
  function poolForCurRound() {
    try {
      const sess = ((diag.net.run && diag.net.run.sess) || '');
      const rid = ((diag.net.run && diag.net.run.runId) || '');
      return evPool.filter((e) => {
        if (!e) return false;
        if (sess && e.sess && e.sess !== sess) return false;
        if (rid && e.runId && e.runId !== rid) return false;
        return true;
      });
    } catch (eF) { return []; }
  }

  /* 学习档案：chrome.storage.local 持久化（verified 条目只有定案来源可写）。 */
  const learnedStore = {
    load() {
      try {
        const raw = localStorage.getItem('knowmodel.learned.v1');
        if (raw) {
          const d = JSON.parse(raw);
          if (d && Array.isArray(d.entries)) return d;
        }
      } catch (eL) {}
      return { entries: [] };
    },
    save(db) {
      try { localStorage.setItem('knowmodel.learned.v1', JSON.stringify(db)); } catch (eS) {}
    },
    clear() {
      try { localStorage.removeItem('knowmodel.learned.v1'); } catch (eC) {}
    },
  };
  function initLearned() {
    try {
      if (typeof KMP_LEARNED === 'undefined') return;
      KMP_LEARNED.setStore({
        load() {
          return new Promise((resolve) => {
            try {
              ext.storage.local.get(['knowmodelLearned']).then((r) => {
                const d = r && r.knowmodelLearned;
                if (d && Array.isArray(d.entries)) return resolve(d);
                resolve(learnedStore.load());
              }).catch(() => resolve(learnedStore.load()));
            } catch (eG) { resolve(learnedStore.load()); }
          });
        },
        save(db) {
          try {
            ext.storage.local.set({ knowmodelLearned: db }).catch(() => {
              try { learnedStore.save(db); } catch (eF2) {}
            });
          } catch (eS2) {
            try { learnedStore.save(db); } catch (eF3) {}
          }
        },
        clear() {
          try {
            ext.storage.local.remove(['knowmodelLearned']).catch(() => {});
            learnedStore.clear();
          } catch (eC2) {}
        },
      });
    } catch (eI) {}
  }
  try { initLearned(); } catch (eI2) {}

  /* 轮内热 id 提升：慢轮等待期里 /out/records 把 run token 明文摆出来
   * （recordsWith(RUNJWT) 的 turn-complete 头），page-world 收不到就喂一次。 */
  function promoteHotId() {
    try {
      if (typeof KMP_LEARNED === 'undefined' || !KMP_LEARNED.findByModelId) return;
      const ids = [];
      try {
        const doc = (typeof document !== 'undefined') ? document : null;
        const html = doc && doc.documentElement ? (doc.documentElement.outerHTML || '') : '';
        const re = /\baccounts\/[a-z0-9_-]+\/models\/[a-z0-9][a-z0-9._-]{1,80}/gi;
        let m;
        while ((m = re.exec(html)) && ids.length < 5) {
          if (ids.indexOf(m[0]) < 0) ids.push(m[0]);
        }
      } catch (eH) {}
      try {
        const logs = ((diag && diag.net && (diag.net.tapLog || diag.net.streams)) || []).slice(-20);
        for (const s of logs) {
          const heads = [s.u, s.head, s.bs].filter(Boolean).join(' ');
          const re2 = /\baccounts\/[a-z0-9_-]+\/models\/[a-z0-9][a-z0-9._-]{1,80}/gi;
          let m2;
          while ((m2 = re2.exec(heads)) && ids.length < 8) {
            if (ids.indexOf(m2[0]) < 0) ids.push(m2[0]);
          }
        }
      } catch (eL2) {}
      for (const id of ids) {
        try {
          const hit = KMP_LEARNED.findByModelId(id);
          if (hit && hit.resolved) {
            poolPush({ source: 'archive.hit', weight: 0.55, modelId: hit.resolved, detail: '档案命中 ' + id, round: true });
            break;
          }
          const parsed = KMP_FUSION.parseCodename(id);
          if (parsed && parsed.family && !parsed.anonymous) {
            poolPush({ source: 'codename.hint', weight: 0.40, family: parsed.family, detail: '代号线索 ' + (parsed.hints[0] || id), round: true });
            break;
          }
        } catch (eP2) {}
      }
    } catch (ePH) {}
  }

  /* 本地证据组装：URL/选择器结论 → idmap.resolve；目录精确映射；indicators。 */
  function buildLocalEvidence(st, models) {
    const evs = [];
    try {
      if (typeof KMP_FUSION === 'undefined') return evs;
      const byId = Object.create(null);
      for (const m of models || []) {
        if (m && m.id) byId[String(m.id).toLowerCase()] = m;
        if (m && m.publicName) byId[String(m.publicName).toLowerCase()] = m;
      }
      for (const m of (st && st.models) || []) {
        const key = String((m && (m.id || m.publicName)) || '').toLowerCase();
        if (!key) continue;
        const hit = byId[key];
        if (hit) {
          evs.push({ source: 'idmap.resolve', weight: 0.92, modelId: hit.publicName || hit.id, detail: '目录精确映射', round: true });
        } else if (key) {
          evs.push({ source: 'dom.text', weight: 0.45, modelId: key.slice(0, 120), detail: 'DOM 文本', round: true });
        }
      }
      for (const ind of (st && st.indicators) || []) {
        const v = String(ind.value || '').slice(0, 160);
        if (!v) continue;
        if (KMP_FUSION.matchKnownModels(v).length) {
          evs.push({ source: 'sse.chunk.model', weight: 0.90, modelId: v.slice(0, 120), detail: ind.signal || '流文本', round: true });
        }
      }
    } catch (eB) {}
    return evs;
  }

  function codenameOf(models) {
    try {
      if (typeof KMP_FUSION === 'undefined' || !models || !models.length) return null;
      const raw = String(models[0].publicName || models[0].id || '');
      if (!raw) return null;
      const p = KMP_FUSION.parseCodename(raw);
      if (!p || (!p.anonymous && !p.hints.length && !p.family)) return null;
      return { raw: p.raw, anonymous: !!p.anonymous, hints: p.hints, family: p.family || null };
    } catch (eC) { return null; }
  }

  async function classifyAndDecorate(base, localEvs) {
    const F = (typeof KMP_FUSION === 'undefined') ? null : KMP_FUSION;
    let evs = poolForCurRound().concat(localEvs || []);
    if (!evs.length) evs = [{ source: 'dom.text', weight: 0.45, detail: '无证据', round: true }];
    let verdict = { mode: 'UNKNOWN', confidence: 0, label: '未识别', evidence: [] };
    if (F) {
      try { verdict = F.classify(evs); } catch (eV) {}
    }
    let payload = F
      ? F.assemblePayload(null, Object.assign({}, base, { codename: codenameOf(base.models) }), verdict)
      : Object.assign({ kind: 'unknown', confidence: 0, evidence: [] }, base);
    // 定案写入档案（只有 run-trace / 投票揭晓这类权威来源）。
    try {
      if (typeof KMP_LEARNED !== 'undefined' && payload.kind === 'resolved' &&
          (payload.source === 'run-trace' || payload.source === 'reveal')) {
        const nm = payload.models && payload.models[0] && (payload.models[0].publicName || payload.models[0].id);
        if (nm) KMP_LEARNED.recordRealModel(nm, { runId: ((diag.net.run && diag.net.run.runId) || '') });
      }
    } catch (eR) {}
    return payload;
  }

  /* 融合落盘：base（形状）+ localEvs → classify → 同 URL 旧结论保护 → 写存储。 */
  async function fuseAndEmit(base, localEvs, opt, prevOverride) {
    opt = opt || {};
    let payload = await classifyAndDecorate(base, localEvs);
    try {
      let prev = null;
      if (prevOverride !== undefined) {
        prev = prevOverride;
      } else {
        const r = await ext.storage.local.get(['currentChat']);
        prev = r && r.currentChat;
      }
      if (!opt.force && prev && prev.url === payload.url && prev.models && prev.models.length) {
        const prevResolved = prev.kind === 'resolved' || prev.source === 'run-trace';
        const curResolved = payload.kind === 'resolved';
        const sameTraceName = prev.source === 'run-trace' && payload.source === 'run-trace' &&
          ((prev.models[0] || {}).publicName) === ((payload.models[0] || {}).publicName);
        if ((prevResolved && !curResolved) || sameTraceName) {
          payload = Object.assign({}, prev, { updatedAt: payload.updatedAt });
        }
      }
    } catch (eP3) {
      /* 读不到旧结论就直接写新结论 */
    }
    try {
      await ext.storage.local.set({ currentChat: payload });
      KnowModelBadge.show(document, KnowModelBadge.textFor(payload));
    } catch (eW) {}
    return payload;
  }

  try {
    window.addEventListener('knowmodel-evidence', function (ev) {
      try {
        const evs = (ev && ev.detail && ev.detail.evs) || [];
        for (const e of evs) poolPush(e);
        const txt = (ev && ev.detail && ev.detail.text) || '';
        if (txt) maybeProbeEvidence(txt);
      } catch (eE) {}
    });
  } catch (eL) {}

  /* 行为探针发送门状态（PelicanSend 同源安全阀）：默认关闭。 */
  function probeArmState() {
    return { armed: false, editorCount: 0, draftConflict: false, routeStable: false, lastSentAt: 0, now: Date.now() };
  }
  async function refreshProbeArm() {
    const st = probeArmState();
    try {
      const r = await ext.storage.local.get(['knowmodelProbeOn']);
      st.armed = !!(r && r.knowmodelProbeOn);
      if (!st.armed) return st;
      const doc = (typeof document !== 'undefined') ? document : null;
      const boxes = doc ? doc.querySelectorAll('textarea, [contenteditable="true"]') : [];
      st.editorCount = boxes ? boxes.length : 0;
      st.routeStable = true;
    } catch (ePA) {}
    return st;
  }
  async function onProbeSend(canary) {
    try {
      if (typeof KMP_FUSION === 'undefined' || !canary) return;
      const st = await refreshProbeArm();
      st.now = Date.now();
      const gate = KMP_FUSION.shouldSendProbe(st);
      if (!gate.ok) { try { diagNote(gate.reason, 'probeGate'); } catch (eG) {} return; }
      await fetch(location.href, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      try { diag.probeSentAt = Date.now(); await persistDiag(); } catch (eD) {}
    } catch (ePS) {}
  }
  function maybeProbeEvidence(answerText) {
    try {
      if (typeof KMP_FUSION === 'undefined' || !answerText) return;
      const evs = KMP_FUSION.runCanaries(answerText);
      for (const e of evs) {
        e.round = true;
        poolPush(e);
      }
      if (evs.length) {
        try { diag.probeEvs = (diag.probeEvs || 0) + evs.length; persistDiag(); } catch (eD2) {}
      }
    } catch (eM) {}
  }

  // TEMP-DIAG：诊断快照——只记 pipeline 状态与 opaque id，不含聊天正文。
  let diag = {
    build: '20260920-evidence-fusion',
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
      // Arena agent 模式的选择器常驻内部模型 "test"（默认选中项），不代表
      // 实际应答模型——/agent/ 页把它当"没找到"，等 run-trace 出真身。
      try {
        if (/\/agent\//.test(payload.url) && payload.models.length === 1) {
          const nm = String((payload.models[0] && payload.models[0].publicName) || '').trim().toLowerCase();
          if (nm === 'test') { payload.models = []; payload.source = 'none'; }
        }
      } catch (eTst) {}
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
        // run-trace 是终局结论（真实应答模型来自 Arena 自家遥测）——同一
        // URL 下 DOM 扫描（selector/page-data）不得把它覆盖回选择器默认值
        // （如 agent 模式常驻的 "test"）。换页（URL 变）或手动 force 才让位；
        // 新一轮 run-trace 自身仍可覆盖（每轮换模型照常生效）。
        if (
          !force &&
          prev &&
          prev.url === payload.url &&
          prev.source === 'run-trace' &&
          prev.models && prev.models.length &&
          payload.source !== 'run-trace'
        ) {
          payload = Object.assign({}, prev, { updatedAt: payload.updatedAt });
        }
      } catch (e) {
        /* 读不到旧结论就直接写新结论 */
      }
      payload = await fuseAndEmit(payload, buildLocalEvidence(st, models), { url: location.href, force: force }, undefined);
      log('detect', deep ? 'deep' : 'light', payload.mode, payload.source, payload.kind || '');
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
      let payload = {
        mode: merged.length === 1 ? 'direct' : 'battle',
        revealed: merged.length > 1,
        models: merged.slice(0, 2),
        source: 'network',
        url: location.href,
        updatedAt: Date.now(),
      };
      try {
        if (typeof KMP_LEARNED !== 'undefined') {
          KMP_LEARNED.learnFromObservation({ text: String(fromUrl || ''), modelIds: ids.slice(0, 8) }, []);
        }
      } catch (eLearn) {}
      try { promoteHotId(); } catch (eHot) {}
      payload = await fuseAndEmit(payload, buildLocalEvidence({ models: payload.models, indicators: [] }, models), { url: location.href }, cur);
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
    var STREAM_CT_RE = /text\/event-stream|application\/x-ndjson|application\/stream\+json|text\/plain|application\/json|application\/octet-stream/i;
    // JWT 形态兜底：token 若换了个键名（如 runToken/token），TOKEN_RE 的
    // access-token 标签就抓瞎。兜底按形态找 JWT 再验 scope（read:runs:run_）。
    var JWT_ANY_RE = /eyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]+/g;
    // 会话制正门形态：{"token": "eyJ..."}（键名就是 token，无 access-token 标签）。
    var TOKEN_JSON_RE = /"(?:public-access-token|access-token|token|runToken)"\s*:\s*"(eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)"/;
    var REALTIME_BASE = 'https://api.trigger.dev';
    var run = { token: null, runId: null, sess: null, sessTok: null, sessExp: 0, exp: 0, fetches: 0, found: null, error: '', polling: false, timer: 0, tries: 0, taps: 0, sockMsgs: 0, searchedKB: 0, streams: [], tapLog: [], reqHdrs: [], reqRuns: [], accepts: [], prevSeq: -1, slowMode: false, doneTok: null, procTok: null };
    // 跳过的条目不值得每次都刷诊断（storage 写太频繁）；节流到 2s 一次。
    // 旁路的流由 watchStream 即时 emit，这里只管“跳过”那一侧。
    var lastTapEmit = 0;
    function emitTapStats() {
      try {
        var now = Date.now();
        if (now - lastTapEmit > 2000) { lastTapEmit = now; emitStats(); }
      } catch (e) {}
    }
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
    // 会话制：scopes 里是 read/write:sessions:<uuid>（uuid 即对话 id），无 run_xxx。
    function sessionIdFromToken(token) {
      try {
        var parts = String(token).split('.');
        if (parts.length < 2) return null;
        var p = JSON.parse(b64url(parts[1]));
        if (!p) return null;
        var scopes = p.scopes || [];
        for (var i = 0; i < scopes.length; i++) {
          var m = String(scopes[i]).match(/^(?:read|write):sessions:([0-9a-fA-F-]{8,})/);
          if (m) return m[1];
        }
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
        if (m) return m[2];
      } catch (e) {}
      // 会话制正门：{"token": JWT} 无标签可循，按 JSON 键名精确抓。
      try {
        var j = TOKEN_JSON_RE.exec(text || '');
        if (j && j[1] && tokenHasRunScope(j[1])) return j[1];
      } catch (e2) {}
      return findTokenByScope(text);
    }
    // 热路径（流式分片）只用标签版，避免每片全量扫形态；阈值处再调全量版。
    function findTokenLabel(text) {
      try {
        var m = TOKEN_RE.exec(text || '');
        return m ? m[2] : null;
      } catch (e) { return null; }
    }
    // 会话制 token（read:sessions:<uuid>）同样接受：run 由后面的
    // out/records 排水分发，不再要求自带 read:runs。
    function tokenHasRunScope(token) {
      try {
        var p = JSON.parse(b64url(String(token).split('.')[1]));
        var scopes = (p && p.scopes) || [];
        for (var i = 0; i < scopes.length; i++) {
          var s = String(scopes[i]);
          if (/(?:read|write):runs:run_/.test(s)) return true;
          if (/(?:read|write):sessions:/.test(s)) return true;
        }
      } catch (e) {}
      return false;
    }
    function findTokenByScope(text) {
      try {
        JWT_ANY_RE.lastIndex = 0;
        var n = 0, m;
        while ((m = JWT_ANY_RE.exec(text || '')) !== null) {
          if (++n > 6) break;
          if (JWT_SHAPE_RE.test(m[0]) && tokenHasRunScope(m[0])) return m[0];
        }
      } catch (e) {}
      return null;
    }
    function stopPoll() {
      try { if (run.timer && typeof clearInterval === 'function') clearInterval(run.timer); } catch (e) {}
      run.timer = 0;
      run.polling = false;
    }
    function acceptToken(token, src) {
      if (!token || typeof token !== 'string') return;
      if (token === run.token) return;
      // 本轮已处理/在途的 run token 不得当新链（SSE 看门狗会把自家 records
      // 响应里的 turn-complete token 喂回来，曾致同 run 无限重置-重拉循环）。
      if (token === run.doneTok || token === run.procTok) return;
      if (!JWT_SHAPE_RE.test(token)) return;
      var rid = runIdFromToken(token);
      var exp = 0;
      try {
        var p = JSON.parse(b64url(String(token).split('.')[1]));
        exp = (p && p.exp) || 0;
      } catch (e) {}
      // 来源取证：这 token 从哪扇门进来的（头/响应/SSE/ES/WS/XHR/种子/自救），
      // 下一轮诊断不用再猜。
      try {
        run.accepts.push({ t: Date.now(), src: String(src || 'unknown'), rid: rid || '' });
        if (run.accepts.length > 8) run.accepts.shift();
      } catch (eA) {}
      // 过期 token 直接拒收：冷打开旧对话时 SSR 残留的是上一个 run 的死 token，
      // 收下只会占槽（!run.token 守卫挡掉之后的新 token）再判 token-expired 走死。
      // 无 exp 声明则放行（无法判断）。自救/自取的新 token 自然新鲜，不受影响。
      if (exp && Date.now() > exp * 1000) return;
      stopPoll();
      run.token = token;
      var sid = sessionIdFromToken(token);
      if (sid) { run.sess = sid; run.sessTok = token; run.sessExp = exp; }
      // 原版：rid 解不出时保留旧 runId（同一 run 的续期 token 仍可用）。
      // 会话制例外：新会话 token 配旧 runId 会拿着错钥匙 403，必须清掉走排水分发。
      if (rid) run.runId = rid;
      else if (sid) run.runId = null;
      else run.runId = run.runId;
      run.exp = exp;
      run.fetches = 0;
      run.sessTries = 0;
      run.found = null;
      run.error = '';
      // 新 token = 新链：上一轮的 doneTok/在途/活性刻度一并清零。
      run.doneTok = null;
      run.procTok = null;
      run.prevSeq = -1;
      run.slowMode = false;
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
      // 会话制第一步：有会话无 run，先排水分发拿 run（不耗 tries 配额）。
      if (token && !rid && run.sess) { fetchSessionRun(); return; }
      if (!token || !rid) { run.error = 'no-token'; stopPoll(); emitStats(); return; }
      // 同原版 fetchRunModels：过期就不再打了（早停，不耗到 30 次）。
      if (run.exp && Date.now() > run.exp * 1000) { run.error = 'token-expired'; stopPoll(); emitStats(); rescueToken(); return; }
      run.fetches++;
      emitStats();
      // 同原版：20s AbortController 超时，跨域挂起也不至于永远卡住。
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
      var done = function () { try { clearTimeout(timer); } catch (e) {} };
      // events 双路：直连老路优先（实测走通过），同源代理兜底（SPA 已改走
      // /ai-proxy，哪天直连被关还能活）。
      var evUrls = [
        { u: TRIGGER_API + '/api/v1/runs/' + rid + '/events', c: 'omit' },
        { u: '/ai-proxy/api/v1/runs/' + rid + '/events', c: 'same-origin' },
      ];
      function evAttempt(i) {
        var cfg = evUrls[Math.min(i, evUrls.length - 1)];
        return fetch(cfg.u, {
          method: 'GET',
          headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
          credentials: cfg.c,
          signal: ctrl ? ctrl.signal : undefined,
        }).then(function (res) {
          if (!res.ok && i + 1 < evUrls.length) return evAttempt(i + 1);
          if (!res.ok) throw new Error('http-' + res.status);
          return res.text();
        });
      }
      evAttempt(0).then(function (text) {
        done();
        run.error = '';
        var labels = extractLabels(text);
        // 终局去重：处理窗口内的并发 events（慢网/轮询重叠）只有第一个
        // 回来的能派发——doneTok 一落，同 token 的后来者全部跳过。
        if (labels.length && token !== run.doneTok) {
          // 同原版：去重后取最后一个（最后一次调用的模型）。
          var uniq = [];
          for (var i = 0; i < labels.length; i++) if (uniq.indexOf(labels[i]) < 0) uniq.push(labels[i]);
          var name = uniq[uniq.length - 1];
          run.found = name;
          stopPoll();
          try {
            window.dispatchEvent(new CustomEvent('knowmodel-run-model', { detail: { name: name, runId: rid, all: uniq } }));
          } catch (e) {}
          // 哨兵态：一轮处理完不死——记下本轮 run token（下一轮 turn-complete
          // 与之不同才算新轮），恢复会话 token 回 records 看哨，降频 30s；
          // 用户再发话（armNextTurn）自动回 6s。每轮换模型也接得住。
          run.doneTok = token;
          if (run.sessTok) { run.token = run.sessTok; run.exp = run.sessExp || 0; }
          run.runId = null;
          run.tries = 0;
          run.sessTries = 0;
          run.slowMode = true;
          try { run.timer = setInterval(pollOnce, 30000); run.polling = true; } catch (eSn) {}
        } else if (run.tries >= 30) {
          run.error = 'no-label';
          // 事件里没标签：不死停，同样回看哨态降频续命。
          if (run.sessTok) { run.token = run.sessTok; run.exp = run.sessExp || 0; }
          run.runId = null;
          run.tries = 0;
          run.slowMode = true;
          stopPoll();
          try { run.timer = setInterval(pollOnce, 30000); run.polling = true; } catch (eSn2) {}
        }
        emitStats();
      }).catch(function (err) {
        done();
        var msg = String((err && err.name === 'AbortError') ? 'timeout-20s' : ((err && err.message) || err));
        run.error = msg.slice(0, 80);
        if (run.tries >= 30) {
          // 事件路连败 30 次：回看哨态降频续命，别死。
          if (run.sessTok) { run.token = run.sessTok; run.exp = run.sessExp || 0; }
          run.runId = null;
          run.tries = 0;
          run.slowMode = true;
          stopPoll();
          try { run.timer = setInterval(pollOnce, 30000); run.polling = true; } catch (eSn3) {}
          rescueToken();
        }
        emitStats();
      });
    }
    // 会话制排水分发：GET realtime/.../out/records 取尾部记录，找 turn-complete
    // 控制记录的 public-access-token 头（run 权限），再走原版 events 链。
    // 30 次配额与 events 共用：排水分发 3 次拿不到 run 就停，不空转。
    function fetchSessionRun() {
      if (run.sessTries === undefined) run.sessTries = 0;
      run.sessTries++;
      run.fetches++;
      emitStats();
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
      var done = function () { try { clearTimeout(timer); } catch (e) {} };
      // 排水分发双路：同源代理优先（SPA 现在就走 /ai-proxy/realtime/...），
      // 直连老路兜底；单条失败自动换路，不再绑死一个域。
      var recUrls = [
        { u: '/ai-proxy/realtime/v1/sessions/' + encodeURIComponent(run.sess) + '/out/records', c: 'same-origin' },
        { u: REALTIME_BASE + '/realtime/v1/sessions/' + encodeURIComponent(run.sess) + '/out/records', c: 'omit' },
      ];
      function recAttempt(i) {
        var cfg = recUrls[Math.min(i, recUrls.length - 1)];
        return fetch(cfg.u, {
          method: 'GET',
          headers: { 'Authorization': 'Bearer ' + run.token, 'Accept': 'application/json' },
          credentials: cfg.c,
          signal: ctrl ? ctrl.signal : undefined,
        }).then(function (res) {
          if (!res.ok && i + 1 < recUrls.length) return recAttempt(i + 1);
          if (!res.ok) throw new Error('http-' + res.status);
          return res.text();
        });
      }
      recAttempt(0).then(function (text) {
        done();
        run.error = '';
        // 活性信号：尾部 seqNum（响应字节会被 ~186KB 截尾，seqNum 单调涨）。
        // 记录还在长 = agent 还在干活，别掐表；慢轮状态下自动回 6s 快轮。
        var lastSeq = -1, recCount = 0;
        try {
          var d0 = JSON.parse(text);
          var rs0 = (d0 && d0.records) || [];
          recCount = rs0.length;
          for (var si = 0; si < rs0.length; si++) { var sn = rs0[si] && rs0[si].seqNum; if (typeof sn === 'number' && sn > lastSeq) lastSeq = sn; }
        } catch (e0) {}
        if (typeof run.prevSeq !== 'number') run.prevSeq = -1;
        run.lastSeq = lastSeq; run.lastRecs = recCount;
        if (recCount > 0 && lastSeq > run.prevSeq) {
          run.tries = 0;
          if (run.slowMode) {
            run.slowMode = false;
            run.prevSeq = lastSeq;
            stopPoll();
            startPoll();
            emitStats();
            return;
          }
        }
        run.prevSeq = lastSeq;
        // 从尾往前找最后一条 turn-complete 的 public-access-token（最新一轮）。
        var lastTok = null;
        try {
          var d = JSON.parse(text);
          var recs = (d && d.records) || [];
          for (var i = recs.length - 1; i >= 0; i--) {
            var hs = recs[i] && recs[i].headers;
            if (!hs) continue;
            var isTC = false, pt = null;
            for (var k = 0; k < hs.length; k++) {
              if (hs[k] && hs[k][0] === 'trigger-control' && String(hs[k][1]).indexOf('turn-complete') >= 0) isTC = true;
              if (hs[k] && hs[k][0] === 'public-access-token' && typeof hs[k][1] === 'string') pt = hs[k][1];
            }
            if (isTC && pt) { lastTok = pt; break; }
          }
        } catch (e) {}
        if (!lastTok) {
          // 兜底：记录体里按形态找带 run 权限的 JWT（头字段若改名仍能活）。
          try {
            JWT_ANY_RE.lastIndex = 0;
            var n = 0, mm;
            while ((mm = JWT_ANY_RE.exec(text || '')) !== null) {
              if (++n > 40) break;
              if (JWT_SHAPE_RE.test(mm[0]) && runIdFromToken(mm[0])) { lastTok = mm[0]; break; }
            }
          } catch (e2) {}
        }
        var rid2 = lastTok ? runIdFromToken(lastTok) : null;
        if (lastTok && rid2 && lastTok !== run.doneTok && lastTok !== run.procTok) {
          // procTok 在途去重：异步 events 没回来前，同轮的并发 poll 不重入。
          run.procTok = lastTok;
          run.token = lastTok;
          run.runId = rid2;
          try { run.accepts.push({ t: Date.now(), src: 'records', rid: rid2 }); if (run.accepts.length > 8) run.accepts.shift(); } catch (eA2) {}
          try { var pp = JSON.parse(b64url(String(lastTok).split('.')[1])); run.exp = (pp && pp.exp) || 0; } catch (e3) {}
          run.error = '';
          emitStats();
          pollOnce();
        } else if (run.tries >= 30) {
          // 空对话/超长 agent 轮都会走到这：不再死停（rescue 的 pulse 如今
          // 不带 token，死停=永死）。降频 30s 续等，记录一动自动回快轮。
          run.slowMode = true;
          run.tries = 0;
          run.error = 'waiting-run';
          stopPoll();
          try { run.timer = setInterval(pollOnce, 30000); run.polling = true; } catch (eSp) {}
          emitStats();
          rescueToken();
        } else {
          // 还没 turn-complete（空对话/agent 在跑），或本轮已处理/在途
          // （doneTok/procTok 相同 = 哨兵态）：继续等下一轮。
          run.error = (lastTok && (lastTok === run.doneTok || lastTok === run.procTok)) ? 'armed' : (run.sessTries >= 3 ? 'waiting-run' : '');
          emitStats();
          if (run.sessTries < 3) {
            try { setTimeout(function () { if (run.polling) pollOnce(); }, 2000); } catch (e4) {}
          }
        }
      }).catch(function (err) {
        done();
        var msg = String((err && err.name === 'AbortError') ? 'timeout-20s' : ((err && err.message) || err));
        run.error = msg.slice(0, 80);
        if (run.tries >= 30) { stopPoll(); rescueToken(); }
        emitStats();
      });
    }
    // 用户发新话（/in/append）或 SPA 重开 /out 流：提速盯新一轮的 turn-complete。
    // 每轮换模型就靠它——哨兵态被这条事件唤回 6s 快轮，新一轮一完成即识别。
    function armNextTurn() {
      try {
        if (!run.sessTok || !run.sess) return;
        run.tries = 0;
        run.sessTries = 0;
        run.slowMode = false;
        run.error = '';
        stopPoll();
        try { run.timer = setInterval(pollOnce, 6000); run.polling = true; } catch (eAn) {}
        pollOnce();
      } catch (eT) {}
    }
    // 主动取 token：会话制下 token 按会话缓存，后几轮页面不再请求正门，
    // 等是等不来的；页面 cookie 还在，自己 GET 一次即可（幂等、无副作用）。
    var tokenFetching = false, directTries = 0;
    // 终局自救：token 过期/切页残留导致整条链走死时，直接向正门要一张当下
    // 有效的（同会话续期或新会话）；acceptToken 鉴别，相同则忽略，不循环。
    function rescueToken() {
      try { fetchDirectToken(true); } catch (e) {}
    }
    function fetchDirectToken(force) {
      if (tokenFetching || (!force && run.token)) return;
      if (directTries >= 3) return;
      directTries++;
      tokenFetching = true;
      try {
        // 正门形态反复横跳：trigger-token 曾 403（Route not allowed）、pulse 曾
        // 带 token 又撤（{"pulse":97,…}）。2026-09-17 实测 trigger-token 复活
        // （200+{"token":…}）。自救两扇门都敲：先 trigger-token，pulse 兜底。
        function deliver(t, src) {
          try {
            tokenFetching = false;
            if (!t || (!force && run.token)) return;
            var mm = TOKEN_JSON_RE.exec(t);
            if (mm && mm[1]) acceptToken(mm[1], 'self:' + src);
          } catch (e) { try { tokenFetching = false; } catch (e2) {} }
        }
        fetch('/api/chat/trigger-token', { credentials: 'same-origin' }).then(function (res) {
          return (res && res.ok) ? res.text() : '';
        }).catch(function () { return ''; }).then(function (t1) {
          var m1 = null;
          try { m1 = TOKEN_JSON_RE.exec(t1 || ''); } catch (e) {}
          if (m1 && m1[1]) { deliver(t1, 'trig'); return; }
          return fetch('/api/me/pulse', { credentials: 'same-origin' }).then(function (res2) {
            return (res2 && res2.ok) ? res2.text() : '';
          }).catch(function () { return ''; }).then(function (t2) { deliver(t2, 'pulse'); });
        }).catch(function () { try { tokenFetching = false; } catch (e) {} });
      } catch (e) { try { tokenFetching = false; } catch (e2) {} }
    }
    // 自愈：snoop 就绪 8s 后仍无 token 且在会话页，自己敲一次正门；切页重来。
    function maybeDirectToken() {
      try {
        if (run.token || directTries >= 3) return;
        if (typeof location === 'undefined' || !/(agent|chat)/i.test(location.href)) return;
        fetchDirectToken(false);
        if (!run.token && directTries < 3) setTimeout(maybeDirectToken, 15000);
      } catch (e) {}
    }
    try { setTimeout(maybeDirectToken, 8000); } catch (e) {}
  try {
    window.addEventListener('knowmodel-probe-fire', function () {
      try {
        if (typeof KMP_FUSION === 'undefined') return;
        const pack = (KMP_FUSION.CANARIES || [])[0];
        if (pack) onProbeSend(pack).catch(function () {});
      } catch (eF) {}
    });
  } catch (eL2) {}
    // SPA 跳转即时通知内容世界：只靠内容世界的 2s 轮询会晚到——页面切页后立刻
    // 取新 token，而旧状态还没清，新 token 会撞上 !run.token 守卫被漏掉。
    try {
      var __kmpNavFire = function () {
        try { window.dispatchEvent(new CustomEvent('knowmodel-nav', { detail: { href: String(location.href) } })); } catch (e) {}
      };
      if (typeof history !== 'undefined' && history.pushState && !history.pushState.__kmpNavWrapped) {
        var __kmpOps = history.pushState, __kmpOrr = history.replaceState;
        var __kmpNp = function () { var r = __kmpOps.apply(this, arguments); try { __kmpNavFire(); } catch (e) {} return r; };
        var __kmpNr = function () { var r = __kmpOrr.apply(this, arguments); try { __kmpNavFire(); } catch (e) {} return r; };
        __kmpNp.__kmpNavWrapped = true;
        __kmpNr.__kmpNavWrapped = true;
        history.pushState = __kmpNp;
        history.replaceState = __kmpNr;
      }
      window.addEventListener('popstate', function () { try { __kmpNavFire(); } catch (e) {} });
    } catch (e) {}
    function watchStream(res, url, entry) {
      run.taps++;
      // 常驻流档案：tapLog 是滚动窗（遥测几分钟就冲掉证据），streams 只记
      // “像流”的条目（SSE 系 CT 或 stream 系 URL），cap 25，晚导出也不丢。
      try {
        var sct = (entry && entry.ct) || '';
        var su = String(url || '');
        if (entry && run.streams.length < 25 && run.streams.indexOf(entry) < 0 &&
            (/event-stream|x-ndjson|stream\+json/i.test(sct) || /(stream|conversation|realtime|batch)/i.test(su))) {
          run.streams.push(entry);
        }
      } catch (e) {}
      emitStats(); // 让诊断区能看到“收到 N 条流”的进度，不至于以为没流量。
      // 渐进读 clone 分支找 token（token 在流开头 headers 帧，不能等流结束）。
      try {
        var reader = res.clone().body.getReader();
        var dec = new TextDecoder();
        var buf = '', bytes = 0, done = false, fbNext = 32768;
        (function pump() {
          reader.read().then(function (r) {
            if (r.done || done) { try { reader.cancel(); } catch (e) {} emitStats(); return; }
            var n = r.value ? r.value.length : 0;
            bytes += n;
            if (entry) { try { entry.kb = Math.round(bytes / 1024); } catch (e2) {} }
            try { buf += dec.decode(r.value || new Uint8Array(0), { stream: true }); } catch (e) {}
            try { run.searchedKB += Math.round(n / 1024); } catch (e2) {}
            // 首块快照（记录结构取证）+ 流里见到的 run_ id 归档（兜底线索）。
            try { if (entry && !entry.head && buf) { entry.head = String(buf).slice(0, 200).replace(/ey[A-Za-z0-9_\-]{6,}/g, function (x) { return 'eyJ…(' + x.length + ')'; }); } } catch (eHd) {}
            try {
              var rids = buf.match(/run_[A-Za-z0-9]{16,}/g);
              if (rids) for (var ri = 0; ri < rids.length && run.reqRuns.length < 12; ri++) if (run.reqRuns.indexOf(rids[ri]) < 0) run.reqRuns.push(rids[ri]);
            } catch (eR) {}
            // 滑动窗口：只留尾部 128KB 供正则（token 是局部模式，JWT 几百字符），
            // 内存有界；不再 512KB 掐流——长 run 的 token 若来得晚，以前永远见不到。
            if (buf.length > 131072) { try { buf = buf.slice(-131072); } catch (e3) {} }
            var tk = findTokenLabel(buf);
            if (!tk && bytes >= fbNext) { fbNext += 131072; tk = findTokenByScope(buf); }
            if (tk) { done = true; if (entry) { try { entry.tok = 1; } catch (e2) {} } acceptToken(tk, 'sse'); try { reader.cancel(); } catch (e) {} return; }
            if (bytes > 10 * 1024 * 1024) { try { reader.cancel(); } catch (e) {} emitStats(); return; }
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
                if (tk) acceptToken(tk, 'es');
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
                try { ev.data.text().then(function (t) { if (!run.token) { var tk2 = findToken(t); if (tk2) acceptToken(tk2, 'ws'); } }).catch(function () {}); return; } catch (e2) {}
              }
              if (!run.token && d) {
                var tk = findToken(d);
                if (tk) acceptToken(tk, 'ws');
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
              run: { build: '20260919-dual-gate', hasToken: !!run.token, accepts: run.accepts.slice(-8), prevSeq: (typeof run.prevSeq === 'number') ? run.prevSeq : -1, slow: !!run.slowMode, done: !!run.doneTok, runId: run.runId || '', sess: run.sess ? String(run.sess).slice(0, 8) : '', fetches: run.fetches, found: run.found || '', error: run.error || '', taps: run.taps, sockMsgs: run.sockMsgs, searchedKB: run.searchedKB, ck: (function () { try { var a = [], dc = (typeof document !== 'undefined' && document.cookie) ? document.cookie : ''; var ps = dc ? dc.split(';') : []; for (var i = 0; i < ps.length && a.length < 20; i++) { var nm = String(ps[i].split('=')[0] || '').trim(); if (nm) a.push(nm); } return a; } catch (e) { return []; } })(), streams: run.streams.slice(-25), tapLog: run.tapLog.slice(-60), reqHdrs: run.reqHdrs.slice(-12), reqRuns: run.reqRuns.slice() },
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
    // 请求侧 token 捕获：新站 SPA 打开旧对话已不调 trigger-token（诊断实锤：
    // 3 次正门请求全是自取的 15s 重试、响应里无 token），鉴权改在
    // /ai-proxy/realtime/.../out、/in/append 的【请求头】里带（Bearer JWT）。
    // 从 init/input 收集请求头，值像 JWT 且带 runs/sessions 权限就收——
    // 名字不设限（Authorization/x-*/随便）；头名记进 reqHdrs 供下次诊断定位。
    function collectReqHeaders(input, init) {
      var out = [];
      function add(k, v) {
        // fetch 规范允许 headers 为 [[name, value], ...] 二元数组序列——实测 SPA
        // 的 fetch 包装器就注入这种格式（之前下标当名、值拼串，JWT 全被漏接）。
        try {
          if (Object.prototype.toString.call(v) === '[object Array]' && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') { k = v[0]; v = v[1]; }
          out.push([String(k), String(v)]);
        } catch (e) {}
      }
      function each(h) {
        try {
          if (!h) return;
          if (typeof h.forEach === 'function') { h.forEach(function (v, k) { add(k, v); }); return; }
          var ks = Object.keys(h);
          for (var i = 0; i < ks.length; i++) add(ks[i], h[ks[i]]);
        } catch (e) {}
      }
      try { if (input && input.headers) each(input.headers); } catch (e) {}
      try { if (init && init.headers) each(init.headers); } catch (e) {}
      return out;
    }
    var REQ_JWT_RE = /^(?:Bearer\s+)?(eyJ[\w-]+\.[\w-]+\.[\w-]+)$/i;
    function captureReqToken(input, init, url) {
      try {
        var su = String(url || '');
        var arenaish = !/^https?:\/\//i.test(su) || /arena\.ai|trigger\.dev/i.test(su);
        if (!arenaish) return;
        var pairs = collectReqHeaders(input, init);
        var names = [], hit = '', hitName = '';
        for (var i = 0; i < pairs.length; i++) {
          names.push(String(pairs[i][0] || '').toLowerCase());
          if (!hit) {
            var mm = REQ_JWT_RE.exec(String(pairs[i][1] || '').trim());
            if (mm) { hit = mm[1]; hitName = String(pairs[i][0] || ''); }
          }
        }
        if (!hit) {
          var um = /[?&](?:token|access[-_]?token|jwt)=(eyJ[\w-]+\.[\w-]+\.[\w-]+)/i.exec(su);
          if (um) { hit = um[1]; hitName = 'url-query'; }
        }
        if (/ai-proxy|realtime|trigger-token|me\/pulse|\/in\/append|\/out/i.test(su) || hit) {
          // 请求体快照（in/append 的 body 里可能有 run/model 线索），JWT 打码。
          var bd = '';
          try {
            if (init && typeof init.body === 'string') bd = init.body.slice(0, 160).replace(/ey[A-Za-z0-9_\-]{6,}/g, function (x) { return 'eyJ…(' + x.length + ')'; });
          } catch (eB) {}
          run.reqHdrs.push({ t: Date.now(), u: su.slice(-60), hn: names.join(',').slice(0, 120), tok: hitName, bd: bd });
          if (run.reqHdrs.length > 12) run.reqHdrs.shift();
        }
        if (hit && tokenHasRunScope(hit)) acceptToken(hit, 'hdr:' + hitName);
        // 新一轮触发器：发话（in/append）或重开 SSE（/out 结尾，排除自家 /out/records）。
        if (/\/in\/append/i.test(su) || /\/out(\?|$)/i.test(su)) { try { armNextTurn(); } catch (eT2) {} }
      } catch (e) {}
    }
    // 探针进化（#4）：协议指纹 / 响应头 / 主机证据进池。
    // 页面世界可直调（content-script 与页面共享 window 命名空间时）；缺席则静默跳过。
    function kmpSniff(url, bodyText, respHeaders) {
      try {
        if (typeof KMP_FUSION === 'undefined') return;
        var evs = [];
        var t = String(bodyText || '').slice(0, 4000);
        if (t) {
          var fps = KMP_FUSION.protocolFingerprint(t);
          for (var i = 0; i < Math.min(2, fps.length); i++) {
            evs.push({ source: 'protocol.framing', weight: fps[i].score, family: fps[i].family, detail: '指纹 ' + fps[i].matched.slice(0, 2).join('+'), round: true });
          }
        }
        if (respHeaders && KMP_FUSION.evidenceFromHeaders) {
          var hevs = KMP_FUSION.evidenceFromHeaders(respHeaders, url);
          for (var j = 0; j < hevs.length; j++) { hevs[j].round = true; evs.push(hevs[j]); }
        }
        if (url) {
          var v = KMP_FUSION.vendorOfHost(url);
          if (v) evs.push({ source: 'url.host.vendor', weight: v.weight, family: v.family, detail: '主机', round: true });
        }
        if (evs.length) {
          try {
            window.dispatchEvent(new CustomEvent('knowmodel-evidence', { detail: { evs: evs.slice(0, 6) } }));
          } catch (eD) {}
        }
      } catch (eS) {}
    }
    
    try {
      var origFetch = window.fetch;
      // 防重包（学原版 __probeWrapped）：SPA/二次注入不再叠床架屋，否则 taps 双计。
      if (origFetch && !origFetch.__kmpWrapped) {
      var kmpFetch = function (input) {
        var url = reqUrl(input);
        // 请求头先于响应就有 token——SPA 打开 /out 那一刻就能拿到会话 JWT。
        try { captureReqToken(input, arguments[1], url); } catch (eH) {}
        return origFetch.apply(this, arguments).then(function (res) {
          try {
            // 门槛学原版 shouldInspect：流式 CT / 无 CT / LLM 风格 URL 都旁路。
            var ct = '';
            try { ct = String((res.headers && res.headers.get('content-type')) || '').toLowerCase(); } catch (e2) {}
            var watchable = !STATIC_EXT_RE.test(url || '') && (STREAM_CT_RE.test(ct) || !ct || STREAM_URL_RE.test(url || ''));
            // 取证日志：每条 fetch 响应都记一笔（URL 尾/CT/旁路否），诊断包里能看到
            // agent 那条流到底长什么样、为什么没命中 token。环 300 条（遥测多，
            // 12 条的话导出时早被冲掉）；另有 streams[] 常驻“像流”的条目防冲刷。
            var entry = null;
            try {
              entry = { t: Date.now(), u: String(url || '').slice(-90), ct: String(ct || '').slice(0, 48), tap: watchable ? 1 : 0, kb: 0, tok: 0 };
              run.tapLog.push(entry);
              if (run.tapLog.length > 300) run.tapLog.shift();
              var rrm = /run_[A-Za-z0-9]{4,}/.exec(url || '');
              if (rrm && run.reqRuns.indexOf(rrm[0]) < 0) {
                run.reqRuns.push(rrm[0]);
                if (run.reqRuns.length > 3) run.reqRuns.shift();
              }
            } catch (e4) {}
            // trigger-token 专线：会话制正门的响应（{"token": JWT}）不等通用
            // clone().text() 链——那条链只认 access-token 标签，会漏抓。
            try {
              // token 正门换地址了：trigger-token 被 403 封死（Route not
              // allowed），新门 = /api/me/pulse——探针实锤其响应带
              // {"token":"eyJ…"}，scopes 即本会话 UUID 的 read/write:sessions。
              // 两条路都盯：状态码+打码正文进日志，token 一见就收。
              if (/(trigger-token|me\/pulse)/i.test(url || '')) {
                if (entry) { try { entry.st = (res && res.status) || 0; } catch (eS) {} }
                res.clone().text().then(function (tt) {
                  try {
                    if (entry) {
                      // 正门响应形态取证：JWT 打码留长度，正文截 140 字符——
                      // 下次诊断直接看到它到底返回了什么形状。
                      entry.bs = String(tt || '').slice(0, 140).replace(/ey[A-Za-z0-9_\-]{6,}/g, function (s) { return 'eyJ…(' + s.length + ')'; });
                    }
                    // 不因槽里有 token 就拒收：旧 token 过期/死锁时，SPA 拿到的新鲜
                    // 正门 token 必须能进（acceptToken 内部有同值/已处理/过期守卫）。
                    var mm = TOKEN_JSON_RE.exec(tt || '');
                    if (mm && mm[1]) { acceptToken(mm[1], 'resp:' + (/pulse/i.test(url) ? 'pulse' : 'trig')); return; }
                    var bare = String(tt || '').trim();
                    if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(bare)) acceptToken(bare, 'resp:bare');
                  } catch (e9) {}
                }).catch(function () {});
              }
            } catch (e8) {}
            if (watchable) {
              try { watchStream(res, url, entry); } catch (e3) {}
            } else {
              emitTapStats();
            }
            if (looksLikeData(res)) {
              res
                .clone()
                .text()
                .then(function (t) {
                  check(t, url);
                  if (!run.token) {
                    var tk = findToken(t);
                    if (tk) acceptToken(tk, 'fetch-data');
                  }
                })
                .catch(function () {});
            }
          } catch (e) {}
          return res;
        });
      };
      kmpFetch.__kmpWrapped = true;
      window.fetch = kmpFetch;
      }
    } catch (e) {}
    try {
      var XHP = XMLHttpRequest.prototype;
      // 防重包：同学原版，重复注入不再叠加监听器。
      if (XHP && XHP.send && !XHP.send.__kmpWrapped) {
      try {
        if (XHP.open && !XHP.open.__kmpWrapped) {
          var origOpen = XHP.open;
          var kmpOpen = function (m, u) { try { this.__kmpUrl = String(u || ''); } catch (eO) {} return origOpen.apply(this, arguments); };
          kmpOpen.__kmpWrapped = true;
          XHP.open = kmpOpen;
        }
      } catch (eOw) {}
      var origSend = XHP.send;
      var kmpSend = function () {
        var xhr = this;
        try {
          // XHR 形态的发话/重开流同样触发新一轮看哨。
          if (/\/in\/append/i.test(String(xhr.__kmpUrl || '')) || /\/out(\?|$)/i.test(String(xhr.__kmpUrl || ''))) { try { armNextTurn(); } catch (eT3) {} }
          // 流式 XHR：progress 增量里找 token，不等 load。
          xhr.addEventListener('progress', function () {
            try {
              if (!run.token && typeof xhr.responseText === 'string' && xhr.responseText.length < 2 * 1024 * 1024) {
                var tk = findToken(xhr.responseText);
                if (tk) acceptToken(tk, 'xhr');
              }
            } catch (e) {}
          });
          xhr.addEventListener('load', function () {
            try {
              if (typeof xhr.responseText === 'string') {
                check(xhr.responseText, xhr.responseURL);
                if (!run.token) {
                  var tk = findToken(xhr.responseText);
                  if (tk) acceptToken(tk, 'xhr');
                }
              }
            } catch (e) {}
          });
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
      kmpSend.__kmpWrapped = true;
      XHP.send = kmpSend;
      }
    } catch (e) {}
    // 内容脚本的种子 token / 切页重置经 CustomEvent 进来（页面世界单向收）。
    try {
      window.addEventListener('knowmodel-run-token-seed', function (ev) {
        try { acceptToken(ev && ev.detail && ev.detail.token, 'seed'); } catch (e) {}
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
          run.searchedKB = 0;
          run.streams = [];
          run.sess = null;
          if (typeof directTries !== 'undefined') { directTries = 0; try { setTimeout(maybeDirectToken, 8000); } catch (e2) {} }
          emitStats();
        } catch (e) {}
      });
    } catch (e) {}
    emitStats();
  }

  // 注入页面上下文的嗅探脚本：函数 toString 内联执行，不 fetch 自身资源（Firefox 曾因此失败）。
  // CSP 若拦截则静默降级，靠 deep 扫描兜底；5 秒没收到 ready 回报就记一笔以便区分。
  // document_start 时 <html> 可能还没出生：MO 等它出生再注（仍远早于页面 bundle），
  // 另加轮询兜底；注上后两边互清，避免重复注入叠钩子。
  let snoopInjected = false;
  function tryInjectSnoopRoot() {
    try {
      const root = document.head || document.documentElement;
      if (!root) return false;
      const src = '(' + snoopPayload.toString() + ')();';
      const el = document.createElement('script');
      el.textContent = src;
      root.appendChild(el);
      el.remove();
      log('snoop injected, src len:', src.length);
      return true;
    } catch (e) {
      diagNote(e, 'ensureNetSnoop');
      return false;
    }
  }
  function armSnoopReadyCheck() {
    try {
      setTimeout(() => {
        if (!diag.net.ready) {
          diagNote(new Error('no snoop ready after 5s (CSP?)'), 'ensureNetSnoop');
          persistDiag();
        }
      }, 5000);
    } catch (e) {}
  }
  function ensureNetSnoop() {
    if (snoopInjected) return;
    snoopInjected = true;
    let finished = false;
    let mo = null;
    let timer = 0;
    const done = () => {
      if (finished) return;
      finished = true;
      try { if (mo) mo.disconnect(); } catch (e) {}
      try { if (timer) clearInterval(timer); } catch (e) {}
      armSnoopReadyCheck();
    };
    if (tryInjectSnoopRoot()) { done(); return; }
    try {
      mo = new MutationObserver(() => {
        try { if (tryInjectSnoopRoot()) done(); } catch (e) {}
      });
      mo.observe(document, { childList: true, subtree: true });
    } catch (e) {}
    try {
      let n = 0;
      timer = setInterval(() => {
        try {
          if (tryInjectSnoopRoot()) done();
          else if (++n > 40) { try { clearInterval(timer); } catch (e) {} timer = 0; }
        } catch (e) {}
      }, 50);
    } catch (e) {}
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
      let payload = {
        mode: 'direct',
        revealed: false,
        models: [info],
        source: 'run-trace',
        url: location.href,
        updatedAt: Date.now(),
      };
      poolPush({ source: 'run.trace.model', weight: 1.00, modelId: name, detail: 'run ' + String(runId || '').slice(0, 24), round: true });
      try {
        if (typeof KMP_LEARNED !== 'undefined' && name) {
          KMP_LEARNED.recordRealModel(name, { runId: runId || '' });
          try { KMP_LEARNED.backfillNames(); } catch (eBf) {}
          const hit = KMP_LEARNED.findByModelId(name);
          if (hit && hit.resolved && hit.resolved !== name) {
            payload.models = [{ publicName: hit.resolved, organization: '', id: 'archive:' + hit.id, capabilities: [] }];
          }
        }
      } catch (eRec) {}
      payload = await fuseAndEmit(payload, [], { url: location.href }, cur);
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
  // 切页后 DOM 是旧对话的水合残留：此时再喂 token 会把旧 token 灌进已清空
  // 的页面世界，旧 token 占位挡掉新链路（专线/自取全看 !run.token）→ 永久未检测到。
  // 所以残留种子只在本次文档载入、尚未观测到切页时喂；切页后靠页面自取 + 专线。
  let navSeen = false;
  function seedRunToken() {
    if (navSeen) return;
    try {
      const html = (document.documentElement && document.documentElement.outerHTML) || '';
      const m = TOKEN_RE.exec(html.slice(0, 4 * 1024 * 1024));
      if (m && m[1]) {
        // 过期残留不喂（页面 acceptToken 同源注释）：旧对话 SSR 里就是死 token，
        // 喂进去占槽又走死；解不出 exp 的放行，页面世界还会再鉴一次。
        try {
          const pay = JSON.parse(atob(m[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
          if (pay && pay.exp && Date.now() > pay.exp * 1000) return;
        } catch (e) { /* 解不出就放行 */ }
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
  // 测试缝：融合管线入口（证据→判定→落盘）。页面世界同样可见（无害：只发
  // 本地 CustomEvent / 读本地 storage，不触网；生产环境未使用）。
  try {
    window.__kmpTest = {
      evidence: function (evs, text) {
        try {
          window.dispatchEvent(new CustomEvent('knowmodel-evidence', { detail: { evs: evs || [], text: text || '' } }));
        } catch (eT) {}
      },
      runModel: function (name, runId) {
        try {
          window.dispatchEvent(new CustomEvent('knowmodel-run-model', { detail: { name: name, runId: runId } }));
        } catch (eT2) {}
      },
      fuse: function (base) {
        return (async function () {
          try {
            const models = await getStoredModels();
            return await fuseAndEmit(base, buildLocalEvidence({ models: base.models, indicators: [] }, models), { url: location.href, force: true }, null);
          } catch (eTF) { return null; }
        })();
      },
    };
  } catch (eT3) {}

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

  // 抢跑：content 脚本 document_start 执行，第一时间把页面钩子装上——这是原版
  // 宿主 document-created 注入的平替。之前 document_idle 进场时页面 bundle 早把
  // 干净 fetch 存起来自用了，主 agent 流永远看不见（taps=12 全是边角料即明证）。
  // iframe 里只装钩子不跑扫描：结论/徽标只归顶层，避免各 frame 互相覆盖结论。
  let isTopFrame = true;
  try { isTopFrame = window.top === window.self; } catch (e) { isTopFrame = false; }
  ensureNetSnoop();
  if (!isTopFrame) return;
  armScan();
  function chatPath(href) {
    try { return new URL(href).pathname; } catch (e) { return String(href || ''); }
  }
  function handleNavReset(newHref) {
    lastHref = newHref;
    navSeen = true;
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
  // 页面世界 history 跳转即时事件（pushState/replaceState/popstate）：pathname
  // 变了才是真切页，query/hash 小动静不折腾（2s 兜底轮询仍看全 href）。
  try {
    window.addEventListener('knowmodel-nav', (ev) => {
      try {
        const h = ev && ev.detail && ev.detail.href;
        if (h && chatPath(h) !== chatPath(lastHref)) handleNavReset(h);
      } catch (e) {}
    });
  } catch (e) {}
  setInterval(() => {
    if (location.href !== lastHref) handleNavReset(location.href);
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
