/* 页面右下角状态徽标（由 content.js 调用）：文字映射 + 元素托管。 */
var KnowModelBadge = (() => {
  'use strict';

  function textFor(cc) {
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

  function show(doc, text) {
    try {
      let el = doc.getElementById('knowmodel-badge');
      if (!el) {
        el = doc.createElement('div');
        el.id = 'knowmodel-badge';
        el.style.cssText =
          'position:fixed;right:12px;bottom:12px;z-index:2147483647;' +
          'background:rgba(20,20,20,.85);color:#fff;font-size:12px;' +
          'padding:6px 12px;border-radius:16px;cursor:pointer;' +
          'font-family:system-ui,sans-serif;max-width:40vw;' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        el.title = 'knowmodel：点击隐藏此徽标';
        el.addEventListener('click', () => el.remove());
        (doc.body || doc.documentElement).appendChild(el);
      }
      el.textContent = text;
    } catch (e) {
      /* DOM 不可用时跳过 */
    }
  }

  return { textFor: textFor, show: show };
})();
