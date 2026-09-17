'use strict';
// 纯逻辑层回归（Q 起）：融合引擎 / 代号解析 / 协议指纹 / 行为探针 / 学习档案。
// 缝：KMP_FUSION / KMP_LEARNED 纯函数（不碰扩展 API、不碰 DOM），
// 直接在 VM 里加载 extension/evidence.js 后断言判定结果。
// （正式场景在探针进化实现落地后补齐，本占位保证 runner 结构先行。）
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const R = (f) => fs.readFileSync('extension/' + f, 'utf8');
const sb = { console };
vm.createContext(sb);
try {
  vm.runInContext(R('evidence.js'), sb);
  assert.ok(sb.KMP_FUSION && typeof sb.KMP_FUSION.classify === 'function', 'KMP_FUSION.classify 存在');
  console.log('Q0 fusion module loads: PASS');
} catch (e) {
  if (String((e && e.message) || e).includes('ENOENT')) {
    console.log('Q0 SKIP: extension/evidence.js not yet implemented');
  } else { throw e; }
}
