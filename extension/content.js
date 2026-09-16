/* 内容脚本（编排层）：模型列表抓取 + 当前对话识别 + 徽标 + 上报。
 * 重活下沉到各模块——KnowModelScan（列表提取）、KnowModelDetector（对话识别）、
 * KnowModelBadge（右下角徽标）、KnowModel（模型小工具）；本文件只做编排：
 * 定时抓取、DOM 变化去抖重检、popup 刷新消息。
 */
'use strict';

(() => {
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

  async function scanModels() {
    const found = KnowModelScan.scanModels(document);
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
      KnowModelBadge.show(document, KnowModelBadge.textFor(payload));
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
