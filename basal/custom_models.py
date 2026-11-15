"""User-added models that load from local folders (not Hugging Face downloads).

Each entry clones defaults from a built-in catalog template, uses synthetic repo ids
`local/<id>` (and `local/<id>-base` when the family needs a base), and registers the
folders via basal.local_models.
"""
from __future__ import annotations

import json
import re
import threading
from dataclasses import replace

from .paths import DATA

STORE = DATA / "custom_models.json"
_lock = threading.RLock()


def _load() -> list[dict]:
    if not STORE.exists():
        return []
    try:
        data = json.loads(STORE.read_text())
        return data if isinstance(data, list) else []
    except (ValueError, OSError):
        return []


def _save(rows: list[dict]) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(STORE)


def list_all() -> list[dict]:
    with _lock:
        return list(_load())


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return (s or "model")[:48]


def _unique_id(name: str, existing: set[str]) -> str:
    base = f"local-{_slug(name)}"
    if base not in existing:
        return base
    n = 2
    while f"{base}-{n}" in existing:
        n += 1
    return f"{base}-{n}"


def template_info() -> list[dict]:
    """Built-in models the UI can clone as a local entry (same adapter & limits)."""
    from .catalog import BUILTIN
    out = []
    for t in BUILTIN:
        out.append({
            "template_id": t.id,
            "name": t.name,
            "adapter": t.adapter,
            "needs_base": bool(t.base),
            "base_hint": t.base.id if t.base else "",
            "memory_gb": t.memory_gb,
            "modalities": list(t.modalities),
            "params": t.params,
            "tagline": t.tagline,
        })
    return out


def _spec_for(row: dict, builtin):
    from .catalog import Repo
    tid = row.get("template_id") or ""
    base_tpl = next((s for s in builtin if s.id == tid), None)
    if base_tpl is None:
        # Legacy rows stored adapter only
        adapter = row.get("adapter")
        base_tpl = next((s for s in builtin if s.adapter == adapter), None)
    if base_tpl is None:
        return None
    mid = row["id"]
    repo = Repo(f"local/{mid}", size_gb=base_tpl.repo.size_gb)
    base = Repo(f"local/{mid}-base", size_gb=base_tpl.base.size_gb) if base_tpl.base else None
    return replace(
        base_tpl,
        id=mid,
        name=row.get("name") or mid,
        maker=row.get("maker") or "本机",
        adapter=base_tpl.adapter,
        repo=repo,
        base=base,
        tagline=row.get("tagline") or f"本机添加，运行方式同 {base_tpl.name}。",
        summary=row.get("summary") or (
            f"从本地目录加载的权重，沿用 {base_tpl.name} 的适配器（{base_tpl.adapter}）与能力限制。"
        ),
        badge="本地",
        headline_metric=row.get("headline_metric") or base_tpl.headline_metric,
        base_id="",
        finetune_dir="",
        temperature=(),
    )


def derived_specs(builtin) -> list:
    out = []
    for row in list_all():
        s = _spec_for(row, builtin)
        if s is not None:
            out.append(s)
    return out


def add(*, name: str, template_id: str, path: str, base_path: str | None = None, maker: str = "本机") -> dict:
    from . import local_models
    from .catalog import BUILTIN, BY_ID, rebuild

    name = (name or "").strip()
    if not name:
        raise ValueError("请填写模型名称。")
    tpl = next((s for s in BUILTIN if s.id == template_id), None)
    if tpl is None:
        raise ValueError(f"未知模板 {template_id!r}。请从已支持的型号中选择一种运行方式。")
    needs_base = bool(tpl.base)
    if needs_base and not (base_path and str(base_path).strip()):
        raise ValueError(f"此类型需要基座模型目录（参考 {tpl.base.id}）。")
    if not needs_base and base_path and str(base_path).strip():
        raise ValueError("此类型不需要基座目录。")

    with _lock:
        rows = _load()
        existing = {r["id"] for r in rows} | set(BY_ID) | {s.id for s in BUILTIN}
        mid = _unique_id(name, existing)
        row = {
            "id": mid,
            "name": name,
            "adapter": tpl.adapter,
            "template_id": tpl.id,
            "maker": (maker or "本机").strip() or "本机",
        }
        repos = {f"local/{mid}": path}
        if needs_base:
            repos[f"local/{mid}-base"] = base_path
        local_models.set_binding(mid, repos)
        rows.append(row)
        _save(rows)

    rebuild()
    return {"id": mid, "name": name, "adapter": tpl.adapter, "template_id": tpl.id}


def delete(model_id: str) -> bool:
    from . import local_models
    from .catalog import rebuild
    with _lock:
        rows = _load()
        nxt = [r for r in rows if r.get("id") != model_id]
        if len(nxt) == len(rows):
            return False
        _save(nxt)
    local_models.clear(model_id)
    rebuild()
    return True


def is_custom(model_id: str) -> bool:
    return any(r.get("id") == model_id for r in list_all())
