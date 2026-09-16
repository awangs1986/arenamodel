"""核心：抓取 arena.ai 并解析 initialModels。

对照 LMArenaBridge.src.main.get_initial_data() 中这段：
    page_body = await page.content()
    match = re.search(r'{\\\\"initialModels\\\\":(\\[.*?\\]),\\\\"initialModel[A-Z]Id', page_body, re.DOTALL)
    models = json.loads(match.group(1).encode().decode('unicode_escape'))
    save_models(models)
"""
from __future__ import annotations

import asyncio
import json
import re

ARENA_URL = "https://arena.ai/"

# 主模式：与原项目完全一致（HTML 转义后的 JSON）
_PATTERNS = [
    re.compile(r'\{\\"initialModels\\":(\[.*?\]),\\"initialModel[A-Z]Id', re.DOTALL),
    # 兜底 1：未转义的明文 JSON
    re.compile(r'"initialModels":\s*(\[.*?\])\s*,\s*"initialModel', re.DOTALL),
    # 兜底 2：只找 initialModels 数组（非贪婪可能截断，仅作最后尝试）
    re.compile(r'initialModels\\?":\s*(\[.*?\])', re.DOTALL),
]

UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def _decode_array(raw: str) -> list:
    s = raw.strip()
    # HTML 里是转义过的：{\\"initialModels\\":...}，需先还原
    if '\\"' in s or "\\\\" in s:
        try:
            s = s.encode().decode("unicode_escape")
        except Exception:
            pass
    return json.loads(s)


def parse_models_from_html(page_body: str) -> list:
    """从页面 HTML 中提取模型列表，失败抛 ValueError。"""
    if not page_body:
        raise ValueError("empty page body")
    errors: list[str] = []
    for pat in _PATTERNS:
        m = pat.search(page_body)
        if not m:
            continue
        try:
            models = _decode_array(m.group(1))
            if isinstance(models, list) and models:
                return models
            errors.append(f"pattern matched but got {type(models).__name__}")
        except Exception as e:  # noqa: BLE001 - 逐个模式试错
            errors.append(str(e)[:120])
            continue
    raise ValueError("initialModels not found" + (f" ({'; '.join(errors)})" if errors else ""))


async def _click_turnstile(page) -> bool:
    """简化版 Turnstile 点击（原项目 browser_utils.click_turnstile 的最小实现）。"""
    selectors = [
        'iframe[src*="challenges.cloudflare.com"]',
        "#cf-turnstile",
        "#cf-turnstile iframe",
    ]
    for sel in selectors:
        try:
            els = await page.query_selector_all(sel)
        except Exception:
            continue
        for el in els or []:
            try:
                await el.click(force=True)
                return True
            except TypeError:
                try:
                    await el.click()
                    return True
                except Exception:
                    continue
            except Exception:
                continue
    return False


async def fetch_html_via_browser(headless: bool = True, settle_seconds: float = 5.0) -> str:
    """主路径：Camoufox 无头浏览器抓取（与原项目相同）。"""
    from camoufox.async_api import AsyncCamoufox

    async with AsyncCamoufox(headless=headless, main_world_eval=True) as browser:
        page = await browser.new_page()
        await page.goto(ARENA_URL, wait_until="domcontentloaded")
        # 等 Cloudflare 挑战消失（原项目轮询 document.title 12 次，这里精简为 6 次）
        for _ in range(6):
            try:
                title = await page.title()
            except Exception:
                title = ""
            if "Just a moment" not in title:
                break
            await _click_turnstile(page)
            try:
                await page.wait_for_function(
                    "() => document.title.indexOf('Just a moment...') === -1",
                    timeout=8000,
                )
                break
            except Exception:
                continue
        await asyncio.sleep(settle_seconds)
        return await page.content()


async def fetch_html_via_http() -> str:
    """兜底路径：纯 httpx（Cloudflare 未拦截时可用，拦截时解析会失败并报错）。"""
    import httpx

    async with httpx.AsyncClient(headers={"User-Agent": UA}, timeout=30, follow_redirects=True) as c:
        r = await c.get(ARENA_URL)
        r.raise_for_status()
        return r.text


async def discover(headless: bool = True, save: bool = True) -> list:
    """抓取并解析，成功时（save=True）写入 models.json。"""
    from .store import save_models

    last_err: Exception | None = None
    # 1) 浏览器主路径
    try:
        html = await fetch_html_via_browser(headless=headless)
        models = parse_models_from_html(html)
        if save:
            save_models(models)
        return models
    except Exception as e:  # noqa: BLE001 - 失败则降级到 httpx
        last_err = e
    # 2) httpx 兜底
    try:
        html = await fetch_html_via_http()
        models = parse_models_from_html(html)
        if save:
            save_models(models)
        return models
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"browser failed ({last_err}); http fallback failed ({e})") from e
