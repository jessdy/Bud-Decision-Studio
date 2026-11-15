"""Bind a catalog model to local weight folders, skipping Hugging Face download.

Persisted in DATA/local_models.json as:
  { "<model_id>": { "repos": { "<hf_repo_id>": "/abs/path", ... } } }

Adapters resolve paths via path_for_repo(); hub.model_status treats bound repos as complete.
Clearing a binding never deletes the user's folders.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from .paths import DATA

STORE = DATA / "local_models.json"
_lock = threading.RLock()

_CFG_NAMES = ("config.json", "adapter_config.json")
_WEIGHT_GLOBS = ("*.safetensors", "*.bin", "*.pt", "pytorch_model*.bin")


def _load() -> dict:
    if not STORE.exists():
        return {}
    try:
        return json.loads(STORE.read_text())
    except (ValueError, OSError):
        return {}


def _save(data: dict) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(STORE)


def all_bindings() -> dict:
    with _lock:
        return _load()


def get(model_id: str) -> dict | None:
    with _lock:
        entry = _load().get(model_id)
    return entry if entry and entry.get("repos") else None


def path_for_repo(repo_id: str) -> Path | None:
    """First local folder bound to this Hugging Face repo id, if still valid."""
    with _lock:
        data = _load()
    for entry in data.values():
        repos = (entry or {}).get("repos") or {}
        raw = repos.get(repo_id)
        if not raw:
            continue
        p = Path(raw)
        try:
            validate_dir(p)
        except ValueError:
            continue
        return p
    return None


def dir_size(path: Path) -> int:
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for name in files:
                try:
                    total += (Path(root) / name).stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def validate_dir(path: str | Path) -> Path:
    """Require an absolute folder with a config and at least one weight file. Raises ValueError (Chinese)."""
    if path is None or not str(path).strip():
        raise ValueError("请提供模型文件夹的完整路径。")
    p = Path(str(path).strip()).expanduser()
    if not p.is_absolute():
        raise ValueError(f"请使用完整路径，而不是 {path!r}。")
    p = Path(os.path.normpath(p))
    if not p.exists():
        raise ValueError(f"找不到文件夹 {p}。请确认磁盘已连接，或另选目录。")
    if not p.is_dir():
        raise ValueError(f"{p} 不是文件夹。")
    has_cfg = any((p / name).is_file() for name in _CFG_NAMES)
    if not has_cfg:
        raise ValueError(f"{p} 中缺少 config.json 或 adapter_config.json，无法识别为模型目录。")
    has_w = False
    for pattern in _WEIGHT_GLOBS:
        if any(p.glob(pattern)):
            has_w = True
            break
    if not has_w:
        # nested shards sometimes live one level down
        for pattern in _WEIGHT_GLOBS:
            if any(p.glob(f"**/{pattern}")):
                has_w = True
                break
    if not has_w:
        raise ValueError(f"{p} 中未找到权重文件（.safetensors / .bin / .pt）。")
    return p


def set_binding(model_id: str, repos: dict[str, str]) -> dict:
    """Validate each path and store the binding. `repos` maps HF repo id -> absolute path."""
    if not repos:
        raise ValueError("请至少指定一个本地模型目录。")
    cleaned = {}
    for rid, path in repos.items():
        cleaned[rid] = str(validate_dir(path))
    with _lock:
        data = _load()
        data[model_id] = {"repos": cleaned}
        _save(data)
    return data[model_id]


def clear(model_id: str) -> bool:
    with _lock:
        data = _load()
        if model_id not in data:
            return False
        del data[model_id]
        _save(data)
    return True


def bind_model(spec, path: str, base_path: str | None = None) -> dict:
    """Map a catalog ModelSpec to local folders. Needs base_path when the model has a base repo."""
    repos_list = spec.repos()
    if not repos_list:
        raise ValueError("该模型没有可绑定的仓库。")
    primary = repos_list[0]
    mapping = {primary.id: path}
    if spec.base:
        if not base_path or not str(base_path).strip():
            raise ValueError(f"{spec.name} 需要基座模型目录（{spec.base.id}）。请同时选择基座文件夹。")
        mapping[spec.base.id] = base_path
    elif base_path and str(base_path).strip():
        raise ValueError(f"{spec.name} 不需要基座目录。")
    return set_binding(spec.id, mapping)
