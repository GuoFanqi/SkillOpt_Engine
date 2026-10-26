from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict
from pathlib import Path
from typing import Any

from skillopt.utils.constraints import validate_forbidden_terms
from skillopt.utils.scoring import is_execution_error


class RolloutCacheError(ValueError):
    pass


def target_runtime_config() -> dict[str, Any]:
    from skillopt.model import azure_openai
    from skillopt.model.backend_config import (
        get_claude_code_exec_config,
        get_codex_exec_config,
        get_target_backend,
    )

    backend = get_target_backend()
    config: dict[str, Any] = {"backend": backend}
    if backend == "qwen_chat":
        from skillopt.model.qwen_backend import TARGET_CONFIG

        config.update({key: value for key, value in asdict(TARGET_CONFIG).items() if key != "api_key"})
    elif backend == "minimax_chat":
        from skillopt.model import minimax_backend

        for name in ("BASE_URL", "TARGET_DEPLOYMENT", "TEMPERATURE", "MAX_TOKENS", "TIMEOUT_SECONDS", "ENABLE_THINKING"):
            config[name.lower()] = getattr(minimax_backend, name)
    elif backend == "claude_chat":
        from skillopt.model import claude_backend

        for name in ("TARGET_DEPLOYMENT", "REASONING_EFFORT", "CLAUDE_BIN", "CLAUDE_PERMISSION_MODE", "CLAUDE_SETTING_SOURCES"):
            config[name.lower()] = getattr(claude_backend, name)
    else:
        for name in ("TARGET_DEPLOYMENT", "TARGET_ENDPOINT", "TARGET_API_VERSION", "TARGET_AUTH_MODE", "REASONING_EFFORT"):
            config[name.lower()] = getattr(azure_openai, name)
        if backend == "codex_exec":
            config["execution"] = get_codex_exec_config()
        elif backend == "claude_code_exec":
            config["execution"] = get_claude_code_exec_config()
    return config


def _file_fingerprints(items: list[dict], parameters: dict) -> dict[str, str]:
    roots = parameters.get("data_dirs") or []
    if isinstance(roots, (str, os.PathLike)):
        roots = [roots]
    roots = [Path(root) for root in roots]
    if parameters.get("data_root"):
        roots.append(Path(parameters["data_root"]))
    paths: set[Path] = {Path(path).resolve() for path in parameters.get("input_files", [])}
    for item in items:
        for key in ("image_path", "image_paths", "source_files", "spreadsheet_path"):
            values = item.get(key) or []
            if isinstance(values, (str, os.PathLike)):
                values = [values]
            for value in values:
                candidate = Path(value)
                candidates = [candidate] if candidate.is_absolute() else [candidate, *(root / candidate for root in roots)]
                for path in candidates:
                    if path.is_file():
                        paths.add(path.resolve())
                    elif key == "spreadsheet_path" and path.is_dir():
                        paths.update(child.resolve() for child in path.rglob("*") if child.is_file())
    digests = {}
    for path in sorted(paths):
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        digests[str(path)] = digest.hexdigest()
    return digests


def rollout_fingerprint(items: list[dict], skill_content: str, parameters: dict, model_config: dict | None = None) -> str:
    recipe = {
        "version": 1,
        "skill": skill_content,
        "model": target_runtime_config() if model_config is None else model_config,
        "parameters": parameters,
        "items": items,
        "files": _file_fingerprints(items, parameters),
    }
    encoded = json.dumps(recipe, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def prepare_rollout_cache(
    out_root: str,
    items: list[dict],
    skill_content: str,
    parameters: dict,
    *,
    model_config: dict | None = None,
) -> tuple[str, list[dict], list[dict]]:
    item_ids = [str(item["id"]) for item in items]
    if len(item_ids) != len(set(item_ids)):
        raise RolloutCacheError("Duplicate item IDs in one rollout; evaluate dataset splits separately.")
    for item in items:
        validate_forbidden_terms(item.get("forbidden_terms", []))
    fingerprint = rollout_fingerprint(items, skill_content, parameters, model_config)
    directory = Path(out_root)
    directory.mkdir(parents=True, exist_ok=True)
    results_path = directory / "results.jsonl"
    manifest_path = directory / "rollout_manifest.json"
    if not manifest_path.exists():
        predictions = directory / "predictions"
        if results_path.exists() or (predictions.is_dir() and any(predictions.iterdir())):
            raise RolloutCacheError(f"Unversioned rollout artifacts in {directory}; keep them and choose a new output directory.")
        try:
            with manifest_path.open("x", encoding="utf-8") as stream:
                json.dump({"version": 1, "fingerprint": fingerprint, "item_count": len(items)}, stream)
        except FileExistsError:
            pass
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise RolloutCacheError(f"Invalid rollout manifest in {directory}; existing artifacts were preserved.") from exc
    if not isinstance(manifest, dict) or manifest.get("fingerprint") != fingerprint:
        raise RolloutCacheError(f"Rollout inputs or model changed in {directory}; keep existing artifacts and choose a new output directory.")

    requested = set(item_ids)
    latest: dict[str, dict] = {}
    if results_path.exists():
        with results_path.open(encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                    item_id = str(row["id"])
                except (ValueError, TypeError, KeyError) as exc:
                    raise RolloutCacheError(f"Invalid cached result at {results_path}:{line_number}; existing artifacts were preserved.") from exc
                if item_id in requested:
                    latest[item_id] = row
    existing = [latest[item_id] for item_id in item_ids if item_id in latest and not is_execution_error(latest[item_id])]
    done_ids = {str(row["id"]) for row in existing}
    pending = [item for item in items if str(item["id"]) not in done_ids]
    return str(results_path), existing, pending
