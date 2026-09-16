/* 命名空间兼容层：Firefox 用 browser（Promise 风格），Chrome/Edge 用 chrome。
 * 业务代码只用 `ext`，两边共用同一套逻辑文件，无需改业务代码。
 * 加载顺序必须在 content.js / popup.js / background.js 之前。 */
var ext = (function () {
  try {
    if (typeof browser !== 'undefined' && browser && browser.storage) return browser;
  } catch (e) {
    /* 忽略，回退到 chrome */
  }
  return chrome;
})();
