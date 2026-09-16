"""FastAPI 查询服务：只暴露模型识别结果。"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse

from . import store
from .discover import discover

REFRESH_INTERVAL = 30 * 60  # 与原项目 periodic_refresh_task 一致：30 分钟


async def _periodic_refresh() -> None:
    while True:
        await asyncio.sleep(REFRESH_INTERVAL)
        try:
            models = await discover(headless=True, save=True)
            print(f"[knowmodel] auto refresh: {len(models)} models")
        except Exception as e:  # noqa: BLE001 - 后台任务不中断服务
            print(f"[knowmodel] auto refresh failed: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    task = asyncio.create_task(_periodic_refresh())
    yield
    task.cancel()


app = FastAPI(title="knowmodel", lifespan=lifespan)


@app.get("/api/v1/models")
def list_models():
    try:
        return store.to_openai_list()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.get("/api/v1/models/lookup")
def lookup(name: str):
    hit = store.resolve(name)
    if not hit:
        raise HTTPException(status_code=404, detail=f"Model '{name}' not found")
    return hit


@app.get("/api/v1/models/raw")
def raw():
    return {"count": len(store.get_models()), "models": store.get_models()}


@app.post("/api/v1/refresh")
async def refresh():
    try:
        models = await discover(headless=True, save=True)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"count": len(models), "models": [m.get("publicName") for m in store.valid_models(models)]}


@app.get("/", response_class=HTMLResponse)
def index():
    models = store.valid_models()
    rows = "\n".join(
        f"<tr><td>{m.get('publicName','')}</td><td>{m.get('organization','')}</td>"
        f"<td><code>{m.get('id','')}</code></td></tr>"
        for m in sorted(models, key=lambda x: str(x.get("publicName")))
    ) or '<tr><td colspan="3">暂无数据，先运行 <code>python -m src.main refresh</code></td></tr>'
    return f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>knowmodel — {len(models)} 个模型</title>
<style>body{{font-family:system-ui;margin:2rem}}table{{border-collapse:collapse;width:100%}}
td,th{{border:1px solid #ddd;padding:6px 10px;font-size:14px}}code{{font-size:12px}}</style>
</head><body><h1>arena.ai 当前模型（{len(models)}）</h1>
<form method="post" action="/api/v1/refresh" onsubmit="fetch('/api/v1/refresh',{{method:'POST'}}).then(r=>r.json()).then(j=>alert('刷新到 '+j.count+' 个'));return false">
<button>立即刷新</button></form><br>
<table><tr><th>publicName</th><th>organization</th><th>内部 id</th></tr>{rows}</table></body></html>"""
