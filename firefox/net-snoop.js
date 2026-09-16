/* 网络嗅探（页面上下文载荷，由 content.js 以 <script> 注入执行）。
 * 不能用扩展 API，只能读写 DOM。做法：hook window.fetch 与 XHR，
 * 把 JSON 响应当 UUID  token 扫描，只把命中的已知模型 id 经 CustomEvent 传出去——
 * 对话正文不出页面上下文。已知 id 列表由 content 脚本经
 * documentElement 的 data-knowmodel-ids 属性传入（存模型后更新）。
 * CSP 若拦截 inline 脚本注入，本文件根本跑不起来，属预期降级（还有页面数据扫描兜底）。
 */
(() => {
  'use strict';

  var ATTR = 'data-knowmodel-ids';
  var UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  var ids = new Set();
  var seen = new Set();

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
  } catch (e) {
    /* 观察不到就只用初值 */
  }

  function check(text) {
    if (!ids.size || !text || typeof text !== 'string') return;
    if (text.length > 4 * 1024 * 1024) return;
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
      window.dispatchEvent(new CustomEvent('knowmodel-net-hit', { detail: { ids: hit } }));
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

  try {
    var origFetch = window.fetch;
    window.fetch = function () {
      return origFetch.apply(this, arguments).then(function (res) {
        try {
          if (looksLikeData(res)) {
            res
              .clone()
              .text()
              .then(check)
              .catch(function () {});
          }
        } catch (e) {
          /* 嗅探失败不影响页面请求本身 */
        }
        return res;
      });
    };
  } catch (e) {
    /* hook 不上就地降级 */
  }

  try {
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      try {
        this.addEventListener('load', function () {
          try {
            if (typeof this.responseText === 'string') check(this.responseText);
          } catch (e) {
            /* 忽略 */
          }
        });
      } catch (e) {
        /* 忽略 */
      }
      return origSend.apply(this, arguments);
    };
  } catch (e) {
    /* hook 不上就地降级 */
  }

  try {
    window.dispatchEvent(new CustomEvent('knowmodel-snoop-ready'));
  } catch (e) {
    /* 忽略 */
  }
})();
