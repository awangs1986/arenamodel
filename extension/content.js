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
            if (looksLikeData(res)) {
              res
                .clone()
                .text()
                .then(function (t) {
                  check(t, url);
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
          xhr.addEventListener('load', function () {
            try {
              if (typeof xhr.responseText === 'string') check(xhr.responseText, xhr.responseURL);
            } catch (e) {}
          });
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
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

  try {
    window.addEventListener('knowmodel-net-hit', onNetHit);
    window.addEventListener('knowmodel-snoop-stats', onSnoopStats);
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
      // 新结论由随后几轮扫描（尤其网络首命中）填进来。
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
