'use strict';

const $ = (s) => document.querySelector(s);
const listEl = $('#list');
const searchEl = $('#q');
const statEl = $('#stat');
const updatedEl = $('#updated');
const emptyEl = $('#empty');
const hintEl = $('#hint');
const toastEl = $('#toast');

let all = [];

// 共享行构建：模型列表（原始模型）与当前对话卡片（识别结果）共用；
// KnowModel.caps 同时兼容 capabilities 对象与中文标签数组两种形态。
function buildRow(m) {
  const div = document.createElement('div');
  div.className = 'row';
  div.title = '点击复制内部 id';

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = m.publicName || '(未命名)';
  div.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'meta';
  if (m.organization) {
    const org = document.createElement('span');
    org.className = 'chip org';
    org.textContent = m.organization;
    meta.appendChild(org);
  }
  for (const c of KnowModel.caps(m)) {
    const s = document.createElement('span');
    s.className = 'chip';
    s.textContent = c;
    meta.appendChild(s);
  }
  div.appendChild(meta);

  const id = document.createElement('div');
  id.className = 'id';
  id.textContent = m.id || '';
  div.appendChild(id);

  div.addEventListener('click', async () => {
    const ok = await copyText(m.id || '');
    toast(ok ? '已复制内部 id' : '复制失败');
  });
  return div;
}

function fmtTime(ts) {
  if (!ts) return '从未抓取';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 1500);
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_e) {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function render() {
  const kw = searchEl.value.trim().toLowerCase();
  const rows = all.filter(
    (m) =>
      !kw ||
      String(m.publicName || '').toLowerCase().includes(kw) ||
      String(m.organization || '').toLowerCase().includes(kw)
  );
  statEl.textContent = `（${all.length} 个${kw ? `，匹配 ${rows.length} 个` : ''}）`;
  listEl.innerHTML = '';
  listEl.style.display = rows.length ? '' : 'none';
  emptyEl.style.display = rows.length ? 'none' : 'block';
  for (const m of rows) {
    listEl.appendChild(buildRow(m));
  }
}

async function load() {
  const { models, updatedAt } = await ext.storage.local.get(['models', 'updatedAt']);
  const raw = Array.isArray(models) ? models : [];
  all = raw
    .filter(KnowModel.isValid)
    .sort((a, b) => String(a.publicName).localeCompare(String(b.publicName), 'zh'));
  updatedEl.textContent =
    '更新于 ' + fmtTime(updatedAt) + (raw.length && raw.length !== all.length ? `（原始 ${raw.length}，已过滤无厂商模型）` : '');
  render();
  await loadChat();
}

searchEl.addEventListener('input', render);

$('#refresh').addEventListener('click', async () => {
  hintEl.textContent = '正在刷新…';
  try {
    const tabs = await ext.tabs.query({ url: 'https://arena.ai/*' });
    if (!tabs.length) {
      hintEl.textContent = '已为你打开 arena.ai，等页面加载完再点刷新。';
      ext.tabs.create({ url: 'https://arena.ai/' });
      return;
    }
    let ok = false;
    for (const t of tabs) {
      try {
        const r = await ext.tabs.sendMessage(t.id, { type: 'knowmodel-rescan' });
        if (r && r.ok) ok = true;
      } catch (e) {
        /* 该标签页内容脚本尚未就绪，跳过 */
      }
    }
    await load();
    hintEl.textContent = ok ? '刷新成功。' : '该标签页还没抓到数据，等几秒再试。';
  } catch (e) {
    hintEl.textContent = '刷新失败：' + e.message;
  }
});

$('#open').addEventListener('click', () => {
  ext.tabs.create({ url: 'https://arena.ai/' });
});

function chatEmpty(text) {
  const d = document.createElement('div');
  d.className = 'chat-empty';
  d.textContent = text;
  return d;
}

async function loadChat() {
  const box = $('#chatBox');
  const modeEl = $('#chatMode');
  let cc = null;
  try {
    ({ currentChat: cc } = await ext.storage.local.get(['currentChat']));
  } catch (e) {
    cc = null;
  }
  box.innerHTML = '';
  if (!cc || !cc.updatedAt) {
    modeEl.textContent = '';
    box.appendChild(chatEmpty('还没有检测数据：打开一个 arena.ai 对话页，插件会自动识别。'));
    return;
  }
  const srcMap = { url: '链接', selector: '页面选择器', reveal: '投票揭晓', 'vote-buttons': '投票区', 'page-data': '页面数据', network: '网络请求', 'run-trace': '运行轨迹', fingerprint: '协议指纹', archive: '学习档案', probe: '行为探针', codename: '代号解析' };
  function kindTag(cc) {
    if (!cc || !cc.kind) return '';
    if (cc.kind === 'resolved') return ' · 定案' + (typeof cc.confidence === 'number' ? ' ' + Math.round(cc.confidence * 100) + '%' : '');
    if (cc.kind === 'inferred') return ' · 推断' + (typeof cc.confidence === 'number' ? ' ' + Math.round(cc.confidence * 100) + '%' : '') + '（具体版本未暴露）';
    return ' · 未识别';
  }
  if (cc.mode === 'direct' && cc.models.length) {
    modeEl.textContent = `直接对话（来源：${srcMap[cc.source] || cc.source}${kindTag(cc)}）`;
    for (const m of cc.models) box.appendChild(buildRow(m));
    if (cc.verdictLabel && cc.kind === 'inferred') box.appendChild(chatEmpty('判定：' + cc.verdictLabel));
    if (cc.codename && (cc.codename.hints || []).length) {
      const hints = cc.codename.anonymous ? ['盲测匿名槽位，身份不可知'] : cc.codename.hints;
      box.appendChild(chatEmpty('代号线索：' + hints.join(' / ')));
    }
  } else if (cc.mode === 'battle' && cc.revealed && cc.models.length) {
    modeEl.textContent = '匿名对战 · 已揭晓' + kindTag(cc);
    for (const m of cc.models) box.appendChild(buildRow(m));
  } else if (cc.mode === 'battle') {
    modeEl.textContent = '匿名对战中';
    box.appendChild(chatEmpty('投票前双方身份不公开（服务器就没下发，前端看不到）。投票揭晓后这里会自动显示双方模型。'));
  } else {
    modeEl.textContent = '';
    box.appendChild(chatEmpty('没检测到对话（首页 / 榜单页会这样）。去开一个对话再回来。'));
  }
}

load();

/* TEMP-DIAG：临时诊断区逻辑，定位后连同 popup.html 里的 diagCard 一起删除。 */
async function loadDiag() {
  const linesEl = $('#diagLines');
  const msgEl = $('#diagMsg');
  let diag = null;
  let cc = null;
  let modelsCached = 0;
  try {
    const r = await ext.storage.local.get(['knowmodelDiag', 'currentChat', 'models', 'knowmodelVerbose']);
    diag = r.knowmodelDiag || null;
    cc = r.currentChat || null;
    modelsCached = Array.isArray(r.models) ? r.models.length : 0;
    $('#toggleVerbose').textContent = r.knowmodelVerbose ? '日志：开' : '日志：关';
  } catch (e) {
    if (linesEl) linesEl.textContent = '读取失败：' + e.message;
    return;
  }
  if (!diag) {
    if (linesEl) linesEl.textContent = '暂无诊断快照：打开一个 arena.ai 页面等几秒再开弹窗。';
    return;
  }
  const evs = diag.events || [];
  const last = evs[evs.length - 1] || {};
  const st = (last && last.stats) || {};
  const rows = [
    '页面：' + (diag.url || ''),
    '缓存模型：' + modelsCached + '　结论：' + ((cc && cc.mode + '/' + cc.source) || '无'),
    '扫描轮次：' + evs.length +
      '　最近：' + (last.mode || '-') + '/' + (last.source || '-') +
      '　列表：' + (last.listFound ? '有' : '无'),
    '页面HTML：' + (st.htmlLen || 0) + ' 字节　目录：' + (st.hasCatalog ? '有' : '无') +
      '　uuid：' + (st.uuidScanned || 0) + ' 个　命中：' + ((st.idHits || []).join(', ') || '无'),
    '按钮：' + (st.btnCount || 0) + ' 个　嗅探：' +
      (diag.net.ready ? ('存活，响应 ' + diag.net.responses + '，命中 ' + diag.net.hits) : '未注入/被CSP拦截'),
    '轨迹：' + (function () {
      const r = (diag.net && diag.net.run) || null;
      if (!r || !r.hasToken) {
        let s = '无 token（发一句话后再看）· 流 ' + (r ? r.taps || 0 : 0) + ' · 已搜 ' + (r ? r.searchedKB || 0 : 0) + 'KB · 消息 ' + (r ? r.sockMsgs || 0 : 0);
        if (r && r.reqRuns && r.reqRuns.length) s += ' · 请求见runId：' + r.reqRuns.join(',');
        const streams = (r && r.streams) || [];
        for (const e of streams.slice(-6)) {
          s += '\n　主干流 ' + (e.kb || 0) + 'KB' + (e.tok ? ' 命中!' : '') + ' | ' + (e.ct || '无CT') + ' | ' + (e.u || '');
        }
        const log = (r && r.tapLog) || [];
        for (const e of log.slice(-4)) {
          s += '\n　流 ' + (e.tap ? '旁路' : '跳过') + ' ' + (e.kb || 0) + 'KB' + (e.tok ? ' 命中!' : '') + ' | ' + (e.ct || '无CT') + ' | ' + (e.u || '');
        }
        return s;
      }
      if (r.found) return '已解析：' + r.found;
      if (r.error) return '轮询中（' + r.fetches + ' 次），最近：' + r.error;
      if (!r.runId && r.sess) return '已拿会话 ' + r.sess + '…，排水分发 run 中（' + r.fetches + ' 次）';
      return '轮询中（' + r.fetches + ' 次），runId=' + (r.runId || '?');
    })(),
  ];
  if (linesEl) linesEl.textContent = rows.join('\n');
  if (msgEl && diag.errors && diag.errors.length) {
    msgEl.textContent = '异常(' + diag.errors.length + ')：' +
      diag.errors.slice(-3).map((e) => e.where + ':' + e.msg).join(' | ');
  }
}

$('#copyDiag').addEventListener('click', async () => {
  try {
    const r = await ext.storage.local.get(['knowmodelDiag', 'currentChat', 'models', 'knowmodelLearned', 'knowmodelProbeOn']);
    const pack = {
      exportedAt: new Date().toISOString(),
      modelsCached: Array.isArray(r.models) ? r.models.length : 0,
      currentChat: r.currentChat || null,
      diag: r.knowmodelDiag || null,
      learned: r.knowmodelLearned || null,
      probeOn: !!(r && r.knowmodelProbeOn),
    };
    const ok = await copyText(JSON.stringify(pack, null, 1));
    toast(ok ? '诊断信息已复制，发给开发者即可' : '复制失败');
  } catch (e) {
    toast('复制失败：' + e.message);
  }
});

$('#toggleProbe').addEventListener('click', async () => {
  try {
    const r = await ext.storage.local.get(['knowmodelProbeOn']);
    const next = !(r && r.knowmodelProbeOn);
    await ext.storage.local.set({ knowmodelProbeOn: next });
    $('#toggleProbe').textContent = next ? '行为探针：开' : '行为探针：关';
    toast(next ? '行为探针已开：仅活跃对话发形状探针，结论只作低权重推断' : '行为探针已关');
  } catch (e) {
    toast('切换失败：' + e.message);
  }
});

$('#copyArchive').addEventListener('click', async () => {
  try {
    const r = await ext.storage.local.get(['knowmodelLearned']);
    const ok = await copyText(JSON.stringify(r && r.knowmodelLearned ? r.knowmodelLearned : { entries: [] }, null, 1));
    toast(ok ? '学习档案已复制' : '复制失败');
  } catch (e) {
    toast('复制失败：' + e.message);
  }
});

$('#clearArchive').addEventListener('click', async () => {
  try {
    await ext.storage.local.remove(['knowmodelLearned']);
    try { localStorage.removeItem('knowmodel.learned.v1'); } catch (e2) {}
    toast('学习档案已清除，下次识别重建');
  } catch (e) {
    toast('清除失败：' + e.message);
  }
});

$('#sendProbe').addEventListener('click', async () => {
  try {
    const r = await ext.storage.local.get(['knowmodelProbeOn']);
    if (!(r && r.knowmodelProbeOn)) { toast('先打开行为探针开关'); return; }
    await ext.storage.local.set({ knowmodelProbeFire: Date.now() });
    toast('已请求发送探针（页面需处于活跃对话）');
  } catch (e) {
    toast('发送失败：' + e.message);
  }
});

$('#toggleVerbose').addEventListener('click', async () => {
  try {
    const r = await ext.storage.local.get(['knowmodelVerbose']);
    const next = !(r && r.knowmodelVerbose);
    await ext.storage.local.set({ knowmodelVerbose: next });
    $('#toggleVerbose').textContent = next ? '日志：开' : '日志：关';
    toast(next ? '详细日志已开：按F12在页面控制台看 [knowmodel]' : '详细日志已关');
  } catch (e) {
    toast('切换失败：' + e.message);
  }
});

loadDiag();
