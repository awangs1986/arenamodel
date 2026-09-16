/* 模型列表抓取（由 content.js 调用）：从文档 HTML 提取 initialModels。
 * 正则与 Python 版 src/discover.py 的 _PATTERNS 对应。 */
var KnowModelScan = (() => {
  'use strict';

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

  function scanScripts(doc) {
    const scripts = doc.querySelectorAll('script');
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (txt.indexOf('initialModels') === -1) continue;
      const hit = scanSource(txt);
      if (hit) return hit;
    }
    return null;
  }

  function scanModels(doc) {
    let found = null;
    try {
      found = scanSource(doc.documentElement.outerHTML);
    } catch (e) {
      found = null;
    }
    if (!found) found = scanScripts(doc);
    return found;
  }

  return { scanModels: scanModels };
})();
