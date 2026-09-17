/* 内容脚本（编排层）：模型列表抓取 + 当前对话识别 + 徽标 + 上报。
 * 重活下沉到各模块——KnowModelScan（列表提取）、KnowModelDetector（对话识别，
 * deep 模式追加"页面数据里的模型 id"扫描）、KnowModelBadge（右下角徽标）、
 * KnowModel（模型小工具）；嗅探载荷在独立文件 snoop.js，由 manifest 以 world:MAIN
 * 静态注册进页面上下文（CSP 免疫；旧内联 <script> 注入会被 script-src 拦截已废弃）。
 * 本文件只做编排：种子目录补齐、定时抓取、DOM 变化去抖重检、
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
  // 档案同步缓存：KMP_LEARNED 全同步读写，chrome.storage 却是异步。
  // 修：之前注入的 load() 返回 Promise，读侧永远读空（回填/命中全死），
  // 写侧每次从空库起步（只留最后一条）。现在内存缓存 + 双写 + 启动即刷新。
  let learnedCache = null;
  function initLearned() {
    try {
      if (typeof KMP_LEARNED === 'undefined') return;
      try { learnedCache = learnedStore.load(); } catch (eSeed) { learnedCache = { entries: [] }; }
      if (!learnedCache || !Array.isArray(learnedCache.entries)) learnedCache = { entries: [] };
      try {
        ext.storage.local.get(['knowmodelLearned']).then((r) => {
          try {
            const d = r && r.knowmodelLearned;
            if (d && Array.isArray(d.entries)) learnedCache = KMP_LEARNED.mergeDbs(learnedCache, d);
          } catch (eM) {}
        }).catch(() => {});
      } catch (eR) {}
      KMP_LEARNED.setStore({
        load() {
          if (learnedCache && Array.isArray(learnedCache.entries)) return learnedCache;
          try { return learnedStore.load(); } catch (eG2) { return { entries: [] }; }
        },
        save(db) {
          try { learnedCache = db; } catch (eC0) {}
          try {
            ext.storage.local.set({ knowmodelLearned: db }).catch(() => {
              try { learnedStore.save(db); } catch (eF2) {}
            });
          } catch (eS2) {
            try { learnedStore.save(db); } catch (eF3) {}
          }
          try { learnedStore.save(db); } catch (eF4) {}
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
  function buildLocalEvidence(st, models, trustArchive) {
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
        } else if (trustArchive && typeof KMP_LEARNED !== 'undefined' && KMP_LEARNED.findByModelId) {
          // 网络命中 + 档案 verified（定案写过档）：按档案回填，不按 DOM 文本计。
          // DOM 文本默认不走这条（trustArchive=false），防聊天记录偶然提及误定案。
          let archived = null;
          try { archived = KMP_LEARNED.findByModelId(key); } catch (eAH2) {}
          if (archived && archived.verified && archived.resolved) {
            evs.push({ source: 'archive.hit', weight: 0.55, modelId: archived.resolved, detail: '档案定案回填', round: true });
          } else if (key) {
            evs.push({ source: 'dom.text', weight: 0.45, modelId: key.slice(0, 120), detail: 'DOM 文本', round: true });
          }
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
        } else if (!m && typeof KMP_LEARNED !== 'undefined' && KMP_LEARNED.findByModelId) {
          // 未收录：只有档案 verified（定案写过档的权威名）才认，野 id 直接丢。
          // 修：老对话里 run trace 吐出目录外新名（如 super_nova_ext），网络侧
          // 命中却因不在目录被整单丢弃 → 永久未检测到。
          let ah = null;
          try { ah = KMP_LEARNED.findByModelId(id); } catch (eAH3) {}
          const rnm = ah && ah.verified && ah.resolved;
          const hk = String(rnm || '').toLowerCase();
          if (rnm && !have[hk]) {
            have[hk] = true;
            merged.push({ publicName: rnm, organization: '', id: 'archive:' + (ah.id || id), capabilities: [] });
            poolPush({ source: 'archive.hit', weight: 0.55, modelId: rnm, detail: '档案定案 ' + String(id).slice(0, 60), round: true });
          }
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
      payload = await fuseAndEmit(payload, buildLocalEvidence({ models: payload.models, indicators: [] }, models, true), { url: location.href }, cur);
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
  // 页世界探针已抽为独立文件 extension/snoop.js，由 manifest 以 world:MAIN
  // 静态注册（CSP 免疫）。此处不再内联注入，握手只看 knowmodel-snoop-stats 上报。

  // 注入页面上下文的嗅探脚本：函数 toString 内联执行，不 fetch 自身资源（Firefox 曾因此失败）。
  // CSP 若拦截则静默降级，靠 deep 扫描兜底；5 秒没收到 ready 回报就记一笔以便区分。
  // document_start 时 <html> 可能还没出生：MO 等它出生再注（仍远早于页面 bundle），
  // 另加轮询兜底；注上后两边互清，避免重复注入叠钩子。
  // 页世界探针（snoop.js）由 manifest 以 world:MAIN 静态注册，与页面同权运行，
  // 不再走 <script> 内联注入——内联脚本会被页面 CSP script-src 直接拦截
  // （Refused to execute inline script），这正是之前部分用户“装了却没数据”的原因。
  // MAIN 世界脚本不受页面 CSP 约束。这里只等探针的 knowmodel-snoop-stats 上报；
  // 5 秒没动静说明 MAIN 注册缺失或浏览器过旧（Firefox 需 ≥128），记一笔进诊断。
  function armSnoopReadyCheck() {
    try {
      setTimeout(() => {
        if (!diag.net.ready) {
          diagNote(new Error('no snoop stats after 5s (world:MAIN missing? browser too old?)'), 'ensureNetSnoop');
          persistDiag();
        }
      }, 5000);
    } catch (e) {}
  }
  function ensureNetSnoop() {
    armSnoopReadyCheck();
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
      trigBody: function (href) { try {
        // 自包含（与 snoop.js 内 triggerPostBody 同逻辑）：__kmpTest 活在内容
        // 世界，看不见页面载荷里的函数，故此处内联同一正则，改一处记得改另一处。
        var mS = /\/agent\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(href || '');
        var sS = (mS && mS[1]) || '';
        return JSON.stringify(sS ? { sessionId: sS } : {});
      } catch (eT2) { return '{}'; } },
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
