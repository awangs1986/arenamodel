/* 内容脚本：两件事
 * 1. 模型列表抓取（原有逻辑）：从页面 HTML 提取 initialModels，存入 storage。
 * 2. 当前对话识别（新增）：用 detector.js 判断直接对话/匿名对战，找出对话背后的
 *    模型，存入 storage.currentChat，并在页面右下角挂一个状态小徽标。
 *    流式输出 / 投票揭晓都会改 DOM，用 MutationObserver 去抖后重检。
 */
'use strict';

(() => {
  // 与 src/discover.py 的 _PATTERNS 对应（s 修饰符让 . 跨行）
  const PATTERNS = [
    /\{\\"initialModels\\":(\[.*?\]),\\"initialModel[A-Z]Id/s,
    /"initialModels"\s*:\s*(\[.*?\])\s*,\s*"initialModel/s,
  ];

  // 转义形态的数组 "...\\"..." 经 \"->" 还原后就是合法 JSON
  //（名字里若有引号原文是 \\\" 还原后仍是合法的 \" 转义，正好正确）。
  function tryParseArray(s) {
    let t = s;
    if (t.includes('\\"')) t = t.split('\\"').join('"');
    return JSON.parse(t);
  }

  function scanSource(src) {
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      const m = re.exec(src);
      if (!m) continue;
      try {
        const arr = tryParseArray(m[1]);
        if (Array.isArray(arr) && arr.length) return arr;
      } catch (e) {
        /* 换下一个模式再试 */
      }
    }
    return null;
  }

  function scanScripts() {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (txt.indexOf('initialModels') === -1) continue;
      const hit = scanSource(txt);
      if (hit) return hit;
    }
    return null;
  }

  function validCount(list) {
    return (list || []).filter((m) => {
      const oc = ((m && m.capabilities) || {}).outputCapabilities || {};
      return (oc.text || oc.search || oc.image) && m.organization && m.publicName;
    }).length;
  }

  async function scanModels() {
    let found = null;
    try {
      found = scanSource(document.documentElement.outerHTML);
    } catch (e) {
      found = null;
    }
    if (!found) found = scanScripts();
    if (found && found.length) {
      await ext.storage.local.set({ models: found, updatedAt: Date.now(), url: location.href });
      try {
        await ext.runtime.sendMessage({ type: 'knowmodel-updated', count: validCount(found) });
      } catch (e) {
        /* popup/background 未监听时忽略 */
      }
    }
    return found;
  }

  async function getStoredModels() {
    try {
      const { models } = await ext.storage.local.get(['models']);
      return Array.isArray(models) ? models : [];
    } catch (e) {
      return [];
    }
  }

  function badgeText(cc) {
    if (!cc || cc.mode === 'unknown' || !cc.models) return 'knowmodel：未检测到对话';
    if (cc.mode === 'direct' && cc.models.length) return '当前模型：' + cc.models[0].publicName;
    if (cc.mode === 'battle') {
      if (cc.revealed && cc.models.length) {
        return '揭晓：' + cc.models.map((m) => m.publicName).join(' vs ');
      }
      return '匿名对战中（投票后揭晓）';
    }
    return 'knowmodel：未检测到对话';
  }

  function ensureBadge(text) {
    try {
      let el = document.getElementById('knowmodel-badge');
      if (!el) {
        el = document.createElement('div');
        el.id = 'knowmodel-badge';
        el.style.cssText =
          'position:fixed;right:12px;bottom:12px;z-index:2147483647;' +
          'background:rgba(20,20,20,.85);color:#fff;font-size:12px;' +
          'padding:6px 12px;border-radius:16px;cursor:pointer;' +
          'font-family:system-ui,sans-serif;max-width:40vw;' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        el.title = 'knowmodel：点击隐藏此徽标';
        el.addEventListener('click', () => el.remove());
        (document.body || document.documentElement).appendChild(el);
      }
      el.textContent = text;
    } catch (e) {
      /* DOM 不可用时跳过 */
    }
  }

  async function updateCurrentChat() {
    try {
      const models = await getStoredModels();
      const st = KnowModelDetector.detect(location.href, document, models);
      const payload = {
        mode: st.mode,
        revealed: !!st.revealed,
        models: st.models || [],
        source: st.source || 'none',
        url: location.href,
        updatedAt: Date.now(),
      };
      await ext.storage.local.set({ currentChat: payload });
      ensureBadge(badgeText(payload));
      return payload;
    } catch (e) {
      return null;
    }
  }

  async function fullScan() {
    const models = await scanModels();
    const chat = await updateCurrentChat();
    return { models: models, chat: chat };
  }

  // 页面是 hydration 渐进渲染的：加载后轮询几次，直到抓到模型列表为止；
  // SPA 切路由不重载文档，顺带监听地址变化后重新抓。
  let tries = 0;
  let lastHref = location.href;
  const timer = setInterval(async () => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      tries = 0;
    }
    tries++;
    const r = await fullScan();
    if ((r.models && r.models.length) || tries >= 12) clearInterval(timer);
  }, 3000);

  // 流式输出 / 投票揭晓都会改 DOM：去抖后重检对话状态（只做轻量检测，不重抓列表）
  let moTimer = null;
  try {
    const mo = new MutationObserver(() => {
      clearTimeout(moTimer);
      moTimer = setTimeout(updateCurrentChat, 1200);
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
