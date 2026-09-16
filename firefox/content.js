/* 内容脚本（编排层）：模型列表抓取 + 当前对话识别 + 徽标 + 上报。
 * 重活下沉到各模块——KnowModelScan（列表提取）、KnowModelDetector（对话识别，
 * deep 模式追加"页面数据里的模型 id"扫描）、KnowModelBadge（右下角徽标）、
 * KnowModel（模型小工具）、net-snoop.js（页面上下文网络嗅探）；本文件只做编排：
 * 定时抓取、DOM 变化去抖重检、网络命中合并、popup 刷新消息。
 */
'use strict';

(() => {
  // 本页抓到过 initialModels（首页/榜单）时，网络命中的 id 只是列表噪音，直接忽略。
  let listFoundOnPage = false;

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
    } catch (e) {
      /* DOM 不可用时跳过 */
    }
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

  async function updateCurrentChat(deep) {
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
      try {
        const { currentChat: prev } = await ext.storage.local.get(['currentChat']);
        if (
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
      return payload;
    } catch (e) {
      return null;
    }
  }

  // 网络嗅探命中（net-snoop.js 经 CustomEvent 传出）：只合并新 id，不重写已有结论。
  async function onNetHit(ev) {
    try {
      if (listFoundOnPage) return;
      const ids = (ev && ev.detail && ev.detail.ids) || [];
      if (!ids.length) return;
      const models = await getStoredModels();
      const byId = Object.create(null);
      for (const m of models) {
        if (m && m.id) byId[String(m.id).toLowerCase()] = m;
      }
      let cur = null;
      try {
        ({ currentChat: cur } = await ext.storage.local.get(['currentChat']));
      } catch (e) {
        cur = null;
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
      /* 合并失败不影响页面 */
    }
  }

  // 注入页面上下文的嗅探脚本：fetch 自身资源后以内联 <script> 执行（无新增 manifest 权限）。
  // CSP 若拦截则静默降级，靠 deep 扫描兜底。
  let snoopInjected = false;
  async function ensureNetSnoop() {
    if (snoopInjected) return;
    snoopInjected = true;
    try {
      const src = await (await fetch(ext.runtime.getURL('net-snoop.js'))).text();
      if (!src) return;
      const el = document.createElement('script');
      el.textContent = src;
      (document.head || document.documentElement).appendChild(el);
      el.remove();
    } catch (e) {
      /* 注不进去就算了 */
    }
  }

  try {
    window.addEventListener('knowmodel-net-hit', onNetHit);
  } catch (e) {
    /* 极端环境跳过 */
  }

  async function fullScan() {
    const models = await scanModels();
    if (!models || !models.length) {
      // 无列表页（agent/对话页）：用缓存 id 喂嗅探器，并做 deep 扫描
      publishModelIds(await getStoredModels());
    }
    ensureNetSnoop();
    const chat = await updateCurrentChat(!models || !models.length);
    return { models: models, chat: chat };
  }

  // 页面是 hydration 渐进渲染的：加载后轮询几次，直到抓到模型列表为止。
  // SPA 切路由不重载文档：地址变化监听器会重置状态并重新拉起扫描（之前定时器停后不再醒是 bug，已改）。
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
      armScan();
    }
  }, 2000);

  // 流式输出 / 投票揭晓都会改 DOM：去抖后重检对话状态（轻量检测，不重做 deep 扫描）
  let moTimer = null;
  try {
    const mo = new MutationObserver(() => {
      clearTimeout(moTimer);
      moTimer = setTimeout(() => updateCurrentChat(false), 1200);
    });
    mo.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  } catch (e) {
    /* 不支持则跳过，靠轮询和手动刷新兜底 */
  }

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'knowmodel-rescan') {
      fullScan().then((r) =>
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
