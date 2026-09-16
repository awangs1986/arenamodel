/* 后台：收到内容脚本上报后，把有效模型数显示在工具栏角标上。 */
'use strict';

try {
  // Chrome MV3 service worker 只允许单个后台文件，在此显式引入兼容层；
  // Firefox event page 已通过 manifest scripts 数组加载，importScripts 不存在会自动跳过。
  if (typeof importScripts === 'function' && typeof ext === 'undefined') importScripts('ext.js');
} catch (e) {
  /* 忽略 */
}

ext.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'knowmodel-updated' && typeof msg.count === 'number') {
    ext.action.setBadgeText({ text: String(msg.count) });
    ext.action.setBadgeBackgroundColor({ color: '#1a73e8' });
  }
});

ext.runtime.onInstalled.addListener(() => {
  ext.action.setBadgeText({ text: '' });
});
