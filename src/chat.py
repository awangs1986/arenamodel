"""当前对话识别（Python 版，对应扩展 detector.js 的 detect 逻辑）。

直接对话看 URL 参数 / 按钮文字；匿名对战看投票按钮——投票前无身份则如实
返回 anonymous，揭晓后从正文捕获双方名字。结果存入 current_chat.json。
"""
from __future__ import annotations

import html as _html
import json
import os
import re
import time
from urllib.parse import urlparse, parse_qs

from .discover import ARENA_URL, fetch_page_html, parse_models_from_html
from .store import capability_kinds, get_models, save_models

CURRENT_CHAT_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "current_chat.json")

_VOTE_RE = re.compile(r"(is better|^tie$|both bad|投票|平局|左侧|右侧|更好|都不|不分上下)", re.IGNORECASE)
_BUTTON_RE = re.compile(r"<(?:button|a)\b[^>]*>(.*?)</(?:button|a)>", re.IGNORECASE | re.DOTALL)
_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
_ARIA_RE = re.compile(r'aria-label="([^"]+)"', re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

_KIND_LABELS = {"text": "文本", "search": "搜索", "image": "生图"}
_URL_KEYS = ("model", "modelId", "modelAId", "modelBId")


def _clean(s: str) -> str:
    return _WS_RE.sub(" ", _TAG_RE.sub("", _html.unescape(s or ""))).strip()


def to_info(m: dict) -> dict:
    return {
        "publicName": m.get("publicName") or "",
        "organization": m.get("organization") or "",
        "id": m.get("id") or "",
        "capabilities": [_KIND_LABELS[k] for k in capability_kinds(m)],
    }


def get_current_chat() -> dict | None:
    try:
        with open(CURRENT_CHAT_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else None
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def save_current_chat(payload: dict) -> None:
    tmp_path = f"{CURRENT_CHAT_FILE}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, CURRENT_CHAT_FILE)


def _body_text(page_html: str) -> str:
    body = re.search(r"<body\b[^>]*>(.*?)</body\s*>", page_html or "", re.IGNORECASE | re.DOTALL)
    return _clean(body.group(1) if body else (page_html or ""))


def detect_current_chat(url: str, page_html: str, models: list, has_catalog: bool = False) -> dict:
    """与 detector.js 同策略：投票按钮 → URL 参数 → 选择器文字 → 未知。"""
    by_id = {m["id"]: m for m in models if m.get("id")}
    by_exact = {m["publicName"]: m for m in models if m.get("publicName")}
    by_lower = {str(m["publicName"]).lower(): m for m in models if m.get("publicName")}

    texts = [_clean(b) for b in _BUTTON_RE.findall(page_html or "")]
    texts += [a.strip() for a in _ARIA_RE.findall(page_html or "")]
    texts = [t for t in texts if t]

    # 1) 匿名对战：投票按钮是强信号
    votes = [t for t in texts if _VOTE_RE.search(t[:40])]
    if len(votes) >= 2:
        body = _body_text(page_html)
        hits = sorted(
            ((body.index(name), name) for name in by_exact if len(name) >= 3 and name in body),
            key=lambda h: h[0],
        )[:2]
        if hits:
            ms = [by_exact[name] for _, name in hits]
            return {"mode": "battle", "revealed": True, "models": [to_info(m) for m in ms], "source": "reveal"}
        return {"mode": "battle", "revealed": False, "models": [], "source": "vote-buttons"}

    # 2) URL 参数 / 路径里的内部 id
    try:
        u = urlparse(url)
        for key in _URL_KEYS:
            for v in parse_qs(u.query).get(key, []):
                if v in by_id:
                    return {"mode": "direct", "revealed": False, "models": [to_info(by_id[v])], "source": "url"}
        for part in [p for p in u.path.split("/") if p]:
            if part in by_id:
                return {"mode": "direct", "revealed": False, "models": [to_info(by_id[part])], "source": "url"}
    except Exception:
        pass

    # 3) 选择器按钮文字：精确命中优先，其次包含匹配（取最长名）
    for t in texts:
        if t in by_exact:
            return {"mode": "direct", "revealed": False, "models": [to_info(by_exact[t])], "source": "selector"}
        if t.lower() in by_lower:
            return {"mode": "direct", "revealed": False, "models": [to_info(by_lower[t.lower()])], "source": "selector"}
    best = ""
    for t in texts:
        if not t or len(t) > 80:
            continue
        for name in by_exact:
            if len(name) >= 3 and name in t and len(name) > len(best):
                best = name
    if best:
        return {"mode": "direct", "revealed": False, "models": [to_info(by_exact[best])], "source": "selector"}

    # 4) 页面数据：搜已知的内部 id（agent 页等无选择器的页面；UUID 碰撞概率约等于 0）。
    # initialModels 目录本身含全部 id，不算证据：由 has_catalog 参数 + 残留字样双重跳过。
    if (
        not has_catalog
        and page_html
        and len(page_html) <= 8 * 1024 * 1024
        and "initialModels" not in page_html
    ):
        seen_ids: set = set()
        hits = []
        for mobj in _UUID_RE.finditer(page_html):
            cand = mobj.group(0)
            m = by_id.get(cand) or by_id.get(cand.lower())
            if m is not None and m.get("id") not in seen_ids:
                seen_ids.add(m.get("id"))
                hits.append(m)
                if len(hits) >= 2:
                    break
        if len(hits) == 1:
            return {"mode": "direct", "revealed": False, "models": [to_info(hits[0])], "source": "page-data"}
        if len(hits) > 1:
            return {"mode": "battle", "revealed": True, "models": [to_info(m) for m in hits], "source": "page-data"}

    return {"mode": "unknown", "revealed": False, "models": [], "source": "none"}


async def refresh_chat(url: str = ARENA_URL, headless: bool = True, save: bool = True) -> dict:
    """抓取对话页并识别当前模型，成功时写入 current_chat.json；含目录时同步更新 models.json，无目录时用缓存识别。"""
    page_html = await fetch_page_html(headless=headless)
    try:
        models = parse_models_from_html(page_html)
        has_catalog = True
        if save:
            save_models(models)
    except ValueError:
        # agent/对话页 HTML 里没有 initialModels(内容客户端后加载):
        # 用缓存模型识别,并启用[页面数据]分支。
        models = get_models()
        has_catalog = False
    payload = detect_current_chat(url, page_html, models, has_catalog=has_catalog)
    payload["url"] = url
    payload["updatedAt"] = int(time.time())
    if save:
        save_current_chat(payload)
    return payload
