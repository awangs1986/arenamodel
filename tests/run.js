// 回归总入口（仓库根目录执行）：node tests/run.js
// 场景命名规则：会话链 A–P（tests/sessionchain.js，页面世界嗅探缝）；
// 新能力从 Q 起追加（tests/fusion.js，纯逻辑层缝：融合/代号/指纹/探针/档案）。
// 追加位置：同文件末尾场景块内，按字母顺序。
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
for (const f of ['tests/sessionchain.js', 'tests/fusion.js']) {
  console.log('=== ' + f + ' ===');
  execFileSync(process.execPath, [path.join(root, f)], { cwd: root, stdio: 'inherit' });
}
console.log('ALL SUITES GREEN');
