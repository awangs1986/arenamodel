"""models.json 读写 + 过滤，对照 LMArenaBridge 的 config.py / list_models。"""
from __future__ import annotations

import json
import os
import time

# 项目根目录 = src/ 的上一级，models.json 放那里（与原项目一致）
MODELS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models.json")


def get_models() -> list:
    try:
        with open(MODELS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save_models(models: list) -> None:
    tmp_path = f"{MODELS_FILE}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(models, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, MODELS_FILE)


def _output_caps(m: dict) -> dict:
    return ((m.get("capabilities") or {}).get("outputCapabilities") or {}) or {}


def is_valid_model(m: dict) -> bool:
    """有效模型：有 text/search/image 输出能力且有 organization（排除 stealth）。"""
    oc = _output_caps(m)
    return bool(
        (oc.get("text") or oc.get("search") or oc.get("image"))
        and m.get("organization")
        and m.get("publicName")
    )


def capability_kinds(m: dict) -> list:
    """返回模型具备的输出能力键（text/search/image 的子集），用于展示。"""
    oc = _output_caps(m)
    return [k for k in ("text", "search", "image") if oc.get(k)]


def valid_models(models: list | None = None) -> list:
    """与原项目 list_models 相同的过滤：有 text/search/image 输出能力且有 organization（排除 stealth）。"""
    models = get_models() if models is None else models
    return [m for m in models if is_valid_model(m)]


def to_openai_list(models: list | None = None) -> dict:
    now = int(time.time())
    return {
        "object": "list",
        "data": [
            {
                "id": m.get("publicName"),
                "object": "model",
                "created": now,
                "owned_by": m.get("organization", "lmarena"),
            }
            for m in valid_models(models)
        ],
    }


def resolve(public_name: str, models: list | None = None) -> dict | None:
    """publicName -> {id, organization, capabilities}，对应原项目 chat/completions 找 modelAId 的一步。"""
    models = get_models() if models is None else models
    for m in models:
        if m.get("publicName") == public_name:
            return {
                "id": m.get("id"),
                "publicName": m.get("publicName"),
                "organization": m.get("organization"),
                "capabilities": m.get("capabilities", {}),
            }
    return None
