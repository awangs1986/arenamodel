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

function capsOf(m) {
  const oc = ((m && m.capabilities) || {}).outputCapabilities || {};
  const out = [];
  if (oc.text) out.push('文本');
  if (oc.search) out.push('搜索');
  if (oc.image) out.push('生图');
  return out;
}

function isValid(m) {
  const oc = ((m && m.capabilities) || {}).outputCapabilities || {};
  return Boolean((oc.text || oc.search || oc.image) && m.organization && m.publicName);
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
    const div = document.createElement('div');
    div.className = 'row';
    div.title = '点击复制内部 id';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = m.publicName || '(未命名)';
    div.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const org = document.createElement('span');
    org.className = 'chip org';
    org.textContent = m.organization || '';
    meta.appendChild(org);
    for (const c of capsOf(m)) {
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
    listEl.appendChild(div);
  }
}

async function load() {
  const { models, updatedAt } = await ext.storage.local.get(['models', 'updatedAt']);
  const raw = Array.isArray(models) ? models : [];
  all = raw
    .filter(isValid)
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

function chatRowEl(m) {
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
  for (const c of m.capabilities || []) {
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
  const srcMap = { url: '链接', selector: '页面选择器', reveal: '投票揭晓', 'vote-buttons': '投票区' };
  if (cc.mode === 'direct' && cc.models.length) {
    modeEl.textContent = `直接对话（来源：${srcMap[cc.source] || cc.source}）`;
    for (const m of cc.models) box.appendChild(chatRowEl(m));
  } else if (cc.mode === 'battle' && cc.revealed && cc.models.length) {
    modeEl.textContent = '匿名对战 · 已揭晓';
    for (const m of cc.models) box.appendChild(chatRowEl(m));
  } else if (cc.mode === 'battle') {
    modeEl.textContent = '匿名对战中';
    box.appendChild(chatEmpty('投票前双方身份不公开（服务器就没下发，前端看不到）。投票揭晓后这里会自动显示双方模型。'));
  } else {
    modeEl.textContent = '';
    box.appendChild(chatEmpty('没检测到对话（首页 / 榜单页会这样）。去开一个对话再回来。'));
  }
}

load();
