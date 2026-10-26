from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


STATE_PREFIX = "SKILLOPT_STATE "


def atomic_json_write(path: str | Path, value: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
            temporary = handle.name
            json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


class RuntimeReporter:
    def __init__(self, out_root: str, instance_id: str | None = None) -> None:
        self.path = Path(out_root) / "runtime_state.json"
        self.instance_id = instance_id or os.environ.get("SKILLOPT_INSTANCE_ID") or uuid.uuid4().hex
        self.state: dict[str, Any] = {
            "last_completed_step": 0, "current_step": 0, "total_steps": 0,
            "current_score": None, "best_score": None, "recipe_hash": "initializing",
        }
        if self.path.exists():
            with self.path.open(encoding="utf-8") as handle:
                previous = json.load(handle)
            if not isinstance(previous, dict):
                raise ValueError("runtime_state.json must contain an object")
            self.state.update(previous)
        self.previous_elapsed = float(self.state.get("elapsed_wall_time_s") or 0)
        self.started = time.monotonic()
        self.sequence = 0
        self.terminal = False
        self.state.update(instance_id=self.instance_id, sequence=0, status="running", phase="pending")
        self.state.pop("error", None)

    def emit(self, phase: str, **fields: Any) -> dict:
        if self.terminal:
            raise RuntimeError("Cannot update a terminal runtime instance")
        completed = int(fields.get("last_completed_step", self.state.get("last_completed_step", 0)))
        previous_completed = int(self.state.get("last_completed_step", 0))
        if completed < previous_completed:
            raise ValueError("Completed steps cannot move backwards")
        sequence = self.sequence + 1
        state = {**self.state, **fields}
        state.update(
            instance_id=self.instance_id,
            sequence=sequence,
            phase=phase,
            updated_at=datetime.now(timezone.utc).isoformat(),
            elapsed_wall_time_s=round(self.previous_elapsed + time.monotonic() - self.started, 3),
        )
        atomic_json_write(self.path, state)
        self.state = state
        self.sequence = sequence
        print(STATE_PREFIX + json.dumps(state, ensure_ascii=False, allow_nan=False), flush=True)
        self.terminal = state["status"] in {"completed", "failed", "stopped"}
        return dict(state)

    def finish(self) -> None:
        self.emit("completed", status="completed")

    def fail(self, error: BaseException) -> None:
        if not self.terminal:
            status = "stopped" if isinstance(error, KeyboardInterrupt) else "failed"
            self.emit(status, status=status, error=f"{type(error).__name__}: {error}")
