/* 模型小工具（共享）：能力标签与有效性判定。
 * 收敛各处重复的 outputCapabilities 三元组判断。
 * caps() 同时兼容两种形态：原始模型（capabilities.outputCapabilities 对象）
 * 与识别结果（capabilities 已是中文标签数组）。 */
var KnowModel = (() => {
  'use strict';

  function outputCaps(m) {
    return (((m || {}).capabilities || {}).outputCapabilities) || {};
  }

  function caps(m) {
    const c = (m || {}).capabilities;
    if (Array.isArray(c)) return c.slice();
    const oc = outputCaps(m);
    const out = [];
    if (oc.text) out.push('文本');
    if (oc.search) out.push('搜索');
    if (oc.image) out.push('生图');
    return out;
  }

  function isValid(m) {
    const oc = outputCaps(m);
    return Boolean((oc.text || oc.search || oc.image) && m && m.organization && m.publicName);
  }

  return { caps: caps, isValid: isValid };
})();
