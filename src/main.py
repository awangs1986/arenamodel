"""CLI 入口：refresh / list / resolve / chat / serve。"""
from __future__ import annotations

import argparse
import asyncio
import sys

from . import store


def cmd_refresh(args) -> int:
    from .discover import discover

    try:
        models = asyncio.run(discover(headless=not args.show, save=True))
    except Exception as e:  # noqa: BLE001
        print(f"抓取失败: {e}", file=sys.stderr)
        return 1
    valid = store.valid_models(models)
    print(f"抓到 {len(models)} 个原始模型，有效 {len(valid)} 个，已存入 models.json")
    for m in sorted(valid, key=lambda x: str(x.get("publicName")))[: args.show_n]:
        print(f"  - {m.get('publicName')}  [{m.get('organization')}]  id={m.get('id')}")
    if len(valid) > args.show_n:
        print(f"  ... 还有 {len(valid) - args.show_n} 个，用 list 查看")
    return 0


def cmd_list(args) -> int:
    models = store.valid_models()
    if args.search:
        kw = args.search.lower()
        models = [m for m in models if kw in str(m.get("publicName", "")).lower()]
    models.sort(key=lambda x: str(x.get("publicName")))
    total = len(models)
    models = models[: args.limit]
    for m in models:
        kinds = store.capability_kinds(m)
        print(f"{m.get('publicName')}  [{m.get('organization')}]  ({','.join(kinds)})")
    print(f"-- 共 {total} 个（models.json 缓存，refresh 更新）")
    return 0


def cmd_resolve(args) -> int:
    hit = store.resolve(args.name)
    if not hit:
        print(f"找不到 '{args.name}'，先 refresh 再用 list 确认显示名", file=sys.stderr)
        return 1
    print(f"publicName:   {hit['publicName']}")
    print(f"id:           {hit['id']}")
    print(f"organization: {hit['organization']}")
    print(f"capabilities: {hit['capabilities']}")
    return 0


def cmd_chat(args) -> int:
    from .chat import refresh_chat

    try:
        cc = asyncio.run(refresh_chat(url=args.url, headless=not args.show, save=True))
    except Exception as e:  # noqa: BLE001
        print(f"检测失败: {e}", file=sys.stderr)
        return 1
    if cc["mode"] == "direct" and cc["models"]:
        m = cc["models"][0]
        print(f"直接对话：{m['publicName']}  [{m['organization']}]  id={m['id']}  （来源：{cc['source']}）")
    elif cc["mode"] == "battle" and cc["revealed"] and cc["models"]:
        print("匿名对战 · 已揭晓：" + " vs ".join(m["publicName"] for m in cc["models"]))
    elif cc["mode"] == "battle":
        print("匿名对战中：投票前双方身份不公开，揭晓后重跑 chat 即可看到。")
    else:
        print("没检测到对话（首页 / 榜单页会这样）：换个对话 URL 再试。")
    return 0


def cmd_serve(args) -> int:
    import uvicorn

    uvicorn.run("src.server:app", host=args.host, port=args.port, reload=False)
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="knowmodel", description="识别 arena.ai 当前模型")
    sub = p.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("refresh", help="抓取一次并存入 models.json")
    pr.add_argument("--show", action="store_true", help="显示浏览器窗口（默认无头）")
    pr.add_argument("--show-n", type=int, default=10)
    pr.set_defaults(func=cmd_refresh)

    pl = sub.add_parser("list", help="查看缓存的模型")
    pl.add_argument("--limit", type=int, default=50)
    pl.add_argument("--search", default="")
    pl.set_defaults(func=cmd_list)

    pv = sub.add_parser("resolve", help="显示名 -> 内部 id")
    pv.add_argument("name")
    pv.set_defaults(func=cmd_resolve)

    pc = sub.add_parser("chat", help="检测指定对话页正在用的模型")
    pc.add_argument("--url", default="https://arena.ai/")
    pc.add_argument("--show", action="store_true", help="显示浏览器窗口（默认无头）")
    pc.set_defaults(func=cmd_chat)

    ps = sub.add_parser("serve", help="启动查询服务")
    ps.add_argument("--host", default="127.0.0.1")
    ps.add_argument("--port", type=int, default=8099)
    ps.set_defaults(func=cmd_serve)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
