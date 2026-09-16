/* 当前对话识别（由 content.js 调用）。
 * 诚实的设计边界：
 * - 直接对话：页面明确知道选了哪个模型 → 可识别（URL 参数 / 模型选择器文字 /
 *   页面数据里的模型内部 id，agent 页就靠这一条）。
 * - 匿名对战：投票前服务器根本不下发身份，前端无从得知 → 只显示"匿名"，
 *   投票揭晓渲染进 DOM 后再自动捕获。
 * 纯逻辑：detect(url, doc, models) 不依赖扩展 API，便于测试。
 */
var KnowModelDetector = (() => {
  'use strict';

  function norm(s) {
    return String(s == null ? '' : s).trim();
  }

  function toInfo(m) {
    return {
      publicName: (m && m.publicName) || '',
      organization: (m && m.organization) || '',
      id: (m && m.id) || '',
      capabilities: KnowModel.caps(m),
    };
  }

  function buildIndex(models) {
    const byId = Object.create(null);
    const byExact = Object.create(null);
    const byLower = Object.create(null);
    for (const m of models || []) {
      if (!m) continue;
      if (m.id) byId[m.id] = m;
      if (m.publicName) {
        byExact[m.publicName] = m;
        byLower[String(m.publicName).toLowerCase()] = m;
      }
    }
    return { byId: byId, byExact: byExact, byLower: byLower };
  }

  function textOf(el) {
    try {
      return norm(el.innerText || el.textContent);
    } catch (e) {
      return '';
    }
  }

  function allButtons(doc) {
    try {
      return Array.prototype.slice.call(
        doc.querySelectorAll('button, [role="button"], [role="combobox"], a')
      );
    } catch (e) {
      return [];
    }
  }

  // URL 里可能直接带内部 id：?model=<id> 或路径 /chat/<id>
  function detectFromUrl(url, idx) {
    try {
      const u = new URL(url);
      const keys = ['model', 'modelId', 'modelAId', 'modelBId'];
      for (const k of keys) {
        const v = u.searchParams.get(k);
        if (v && idx.byId[v]) return { model: idx.byId[v], via: 'url' };
      }
      const parts = u.pathname.split('/').filter(Boolean);
      for (const p of parts) {
        if (idx.byId[p]) return { model: idx.byId[p], via: 'url' };
      }
    } catch (e) {
      /* 非法 URL 则跳过 */
    }
    return null;
  }

  // 模型选择器按钮的文字 / aria-label 命中已知模型名
  function detectFromSelector(doc, idx) {
    const els = allButtons(doc);
    for (const el of els) {
      // 精确命中优先
      const t = textOf(el);
      if (t && (idx.byExact[t] || idx.byLower[t.toLowerCase()])) {
        return { model: idx.byExact[t] || idx.byLower[t.toLowerCase()], via: 'selector' };
      }
      try {
        const aria = norm(el.getAttribute && el.getAttribute('aria-label'));
        if (aria && (idx.byExact[aria] || idx.byLower[aria.toLowerCase()])) {
          return { model: idx.byExact[aria] || idx.byLower[aria.toLowerCase()], via: 'selector' };
        }
      } catch (e) {
        /* 忽略 */
      }
    }
    // 次选：文字里包含全名（如 "Demo-A ▾"）
    let best = null;
    for (const el of els) {
      const t = textOf(el);
      if (!t || t.length > 80) continue;
      for (const name of Object.keys(idx.byExact)) {
        if (name.length < 3) continue;
        if (t.indexOf(name) !== -1 && (!best || name.length > best.length)) best = name;
      }
    }
    if (best) return { model: idx.byExact[best], via: 'selector' };
    return null;
  }

  // 投票按钮是匿名对战的最强信号（A is better / Tie / 投票 / 平局 …）
  var VOTE_RE = /(is better|^tie$|both bad|投票|平局|左侧|右侧|更好|都不|不分上下)/i;

  function findVoteButtons(doc) {
    return allButtons(doc).filter((el) => VOTE_RE.test(textOf(el).slice(0, 40)));
  }

  function bodyTextOf(doc) {
    try {
      const b = doc.body;
      return norm((b && (b.innerText || b.textContent)) || '');
    } catch (e) {
      return '';
    }
  }

  // 揭晓后名字会渲染进正文：按出现顺序取已知模型名（最多 2 个，避免榜单页误伤）
  function findKnownNames(bodyText, idx) {
    const hits = [];
    if (!bodyText) return hits;
    for (const name of Object.keys(idx.byExact)) {
      if (name.length < 3) continue;
      const at = bodyText.indexOf(name);
      if (at !== -1) hits.push({ name: name, at: at });
    }
    hits.sort((a, b) => a.at - b.at);
    return hits.slice(0, 2).map((h) => idx.byExact[h.name]);
  }

  var UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  // agent 页等无模型选择器的页面：全页搜已知的模型内部 id（UUID 碰撞概率≈0，命中即强信号）。
  // initialModels 本身含全部 id，所以只在没抓到列表时调用（deep 模式，见 content.js）。
  // TEMP-DIAG：同步收集 uuid 样本与计数，供诊断包定位用，定位后可删 sample 字段。
  function scanPageIds(doc, idx) {
    const st = { found: [], scanned: 0, htmlLen: 0, hasCatalog: false, sample: [] };
    let html = '';
    try {
      html = doc.documentElement.outerHTML || '';
    } catch (e) {
      return st;
    }
    st.htmlLen = html.length;
    st.hasCatalog = html.indexOf('initialModels') !== -1;
    if (!html || html.length > 8 * 1024 * 1024 || st.hasCatalog) return st;
    const seen = Object.create(null);
    const seenTok = Object.create(null);
    UUID_RE.lastIndex = 0;
    let m;
    while ((m = UUID_RE.exec(html)) !== null) {
      st.scanned++;
      const tok = m[0].toLowerCase();
      if (!seenTok[tok] && st.sample.length < 30) {
        seenTok[tok] = true;
        st.sample.push(tok);
      }
      const hit = idx.byId[m[0]] || idx.byId[tok];
      if (hit && !seen[hit.id]) {
        seen[hit.id] = true;
        st.found.push(hit);
      }
      if (st.found.length >= 2 && st.sample.length >= 30) break;
    }
    return st;
  }

  function findKnownIds(doc, idx) {
    return scanPageIds(doc, idx).found;
  }

  // TEMP-DIAG：诊断快照（控件文字 + uuid 统计，不读聊天正文），定位后可删。
  function stats(doc, models) {
    const idx = buildIndex(models);
    const scan = scanPageIds(doc, idx);
    const btns = allButtons(doc);
    const btnTexts = [];
    const ariaLabels = [];
    const seenAria = Object.create(null);
    for (const el of btns) {
      const t = textOf(el).slice(0, 60);
      if (t && btnTexts.length < 30) btnTexts.push(t);
      try {
        const a = (el.getAttribute && el.getAttribute('aria-label')) || '';
        if (a && !seenAria[a] && ariaLabels.length < 30) {
          seenAria[a] = true;
          ariaLabels.push(a.slice(0, 60));
        }
      } catch (e) {
        /* 忽略单个控件异常 */
      }
      if (btnTexts.length >= 30 && ariaLabels.length >= 30) break;
    }
    return {
      htmlLen: scan.htmlLen,
      hasCatalog: scan.hasCatalog,
      uuidScanned: scan.scanned,
      uuidSample: scan.sample,
      idHits: scan.found.map((m) => (m && m.publicName) || ''),
      btnCount: btns.length,
      btnTexts: btnTexts,
      ariaLabels: ariaLabels,
    };
  }

  function detect(url, doc, models, opts) {
    const idx = buildIndex(models);
    const voteBtns = findVoteButtons(doc);
    if (voteBtns.length >= 2) {
      const names = findKnownNames(bodyTextOf(doc), idx);
      if (names.length) {
        return { mode: 'battle', revealed: true, models: names.map((m) => toInfo(m)), source: 'reveal' };
      }
      return { mode: 'battle', revealed: false, models: [], source: 'vote-buttons' };
    }
    const fromUrl = detectFromUrl(url, idx);
    if (fromUrl) return { mode: 'direct', revealed: false, models: [toInfo(fromUrl.model)], source: 'url' };
    const fromSel = detectFromSelector(doc, idx);
    if (fromSel) return { mode: 'direct', revealed: false, models: [toInfo(fromSel.model)], source: 'selector' };
    if (opts && opts.deep) {
      const idHits = findKnownIds(doc, idx);
      if (idHits.length === 1) {
        return { mode: 'direct', revealed: false, models: [toInfo(idHits[0])], source: 'page-data' };
      }
      if (idHits.length > 1) {
        return { mode: 'battle', revealed: true, models: idHits.map((m) => toInfo(m)), source: 'page-data' };
      }
    }
    return { mode: 'unknown', revealed: false, models: [], source: 'none' };
  }

  return { detect: detect, stats: stats };
})();
