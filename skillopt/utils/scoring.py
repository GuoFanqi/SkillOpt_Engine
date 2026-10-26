"""Scoring and hashing utilities."""
from __future__ import annotations

import hashlib


def _result_field(result: object, name: str, default=None):
    if isinstance(result, dict):
        return result.get(name, default)
    if hasattr(result, name):
        return getattr(result, name)
    return getattr(result, "extras", {}).get(name, default)


def is_execution_error(result: object) -> bool:
    explicit = _result_field(result, "execution_error")
    if explicit is not None:
        return bool(explicit)
    return (
        _result_field(result, "agent_ok") is False
        or _result_field(result, "llm_ok") is False
        or _result_field(result, "phase") in {"timeout", "error"}
    )


def evaluation_coverage(results: list) -> dict[str, int | float]:
    total = len(results)
    failed = sum(is_execution_error(result) for result in results)
    return {
        "total": total,
        "valid": total - failed,
        "execution_errors": failed,
        "coverage": (total - failed) / total if total else 0.0,
    }


class IncompleteEvaluationError(RuntimeError):
    def __init__(self, results: list):
        self.coverage = evaluation_coverage(results)
        super().__init__(
            "Evaluation incomplete: "
            f"{self.coverage['valid']}/{self.coverage['total']} valid results, "
            f"{self.coverage['execution_errors']} execution errors; no score was produced."
        )


def ensure_complete_evaluation(results: list) -> None:
    if not results or any(is_execution_error(result) for result in results):
        raise IncompleteEvaluationError(results)


def compute_score(results: list) -> tuple[float, float]:
    """Score a complete evaluation without dropping failed executions."""
    ensure_complete_evaluation(results)

    def _hard(r: object) -> float:
        return float(r.hard if hasattr(r, "hard") else r.get("hard", 0))

    def _soft(r: object) -> float:
        return float(r.soft if hasattr(r, "soft") else r.get("soft", 0.0))

    hard = sum(_hard(r) for r in results) / len(results)
    soft = sum(_soft(r) for r in results) / len(results)
    return hard, soft


def skill_hash(content: str) -> str:
    """Return a short deterministic hash of skill content (for caching)."""
    return hashlib.sha256(content.encode()).hexdigest()[:16]
