from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from skillopt.engine import runtime


class RuntimeReporterTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.path = self.root / "runtime_state.json"
        self.output = io.StringIO()
        self.stdout = redirect_stdout(self.output)
        self.stdout.__enter__()
        self.addCleanup(self.stdout.__exit__, None, None, None)

    def read_state(self):
        return json.loads(self.path.read_text())

    def test_emit_preserves_checkpoint_fields_and_publishes_snapshot(self):
        old = {"last_completed_step": 3, "current_score": 0.0, "current_skill_path": "skills/v3.md", "checkpoint": {"seed": 7}}
        self.path.write_text(json.dumps(old))
        reporter = runtime.RuntimeReporter(str(self.root), instance_id="new-instance")
        state = reporter.emit("reflect", current_step=4, total_steps=8)
        for key, value in old.items():
            self.assertEqual(state[key], value)
        self.assertEqual(state["instance_id"], "new-instance")
        self.assertEqual(state["status"], "running")
        self.assertEqual(self.read_state(), state)
        line = self.output.getvalue().strip()
        self.assertTrue(line.startswith(runtime.STATE_PREFIX))
        self.assertEqual(json.loads(line[len(runtime.STATE_PREFIX):]), state)

    def test_atomic_write_uses_same_directory_replace(self):
        self.path.write_text('{"old": true}')
        replace = runtime.os.replace
        observed = []

        def inspect_replace(source, target):
            self.assertEqual(self.read_state(), {"old": True})
            self.assertEqual(Path(source).parent, self.root)
            self.assertEqual(json.loads(Path(source).read_text()), {"new": True})
            observed.append(source)
            replace(source, target)

        with patch.object(runtime.os, "replace", side_effect=inspect_replace), patch.object(runtime.os, "fsync", wraps=runtime.os.fsync) as fsync:
            runtime.atomic_json_write(self.path, {"new": True})
        self.assertEqual(len(observed), 1)
        fsync.assert_called_once()
        self.assertEqual(self.read_state(), {"new": True})
        self.assertEqual(list(self.root.iterdir()), [self.path])

    def test_atomic_write_failure_keeps_previous_file_and_removes_temporary_file(self):
        self.path.write_text('{"old": true}')
        with patch.object(runtime.os, "replace", side_effect=OSError("synthetic replace failure")):
            with self.assertRaises(OSError):
                runtime.atomic_json_write(self.path, {"new": True})
        self.assertEqual(self.read_state(), {"old": True})
        self.assertEqual(list(self.root.iterdir()), [self.path])

    def test_non_finite_json_does_not_replace_valid_checkpoint(self):
        self.path.write_text('{"last_completed_step": 2}')
        with self.assertRaises(ValueError):
            runtime.atomic_json_write(self.path, {"score": float("nan")})
        self.assertEqual(self.read_state(), {"last_completed_step": 2})
        self.assertEqual(list(self.root.iterdir()), [self.path])

    def test_new_instance_resets_sequence_but_keeps_checkpoint_and_elapsed_time(self):
        self.path.write_text(json.dumps({"instance_id": "old", "sequence": 8, "status": "failed", "error": "old error", "last_completed_step": 2, "elapsed_wall_time_s": 10}))
        with patch.object(runtime.time, "monotonic", side_effect=[100.0, 102.0, 103.0]):
            reporter = runtime.RuntimeReporter(str(self.root), instance_id="new")
            first = reporter.emit("rollout", current_step=3)
            second = reporter.emit("reflect", current_step=3)
        self.assertEqual((first["sequence"], second["sequence"]), (1, 2))
        self.assertEqual(first["elapsed_wall_time_s"], 12.0)
        self.assertEqual(second["elapsed_wall_time_s"], 13.0)
        self.assertEqual(second["last_completed_step"], 2)
        self.assertNotIn("error", second)
        self.assertEqual(second["instance_id"], "new")
        self.assertEqual(second["status"], "running")

    def test_terminal_instances_cannot_regress(self):
        for terminal in ("completed", "failed", "stopped"):
            with self.subTest(terminal=terminal):
                reporter = runtime.RuntimeReporter(str(self.root), instance_id=terminal)
                reporter.emit("rollout", last_completed_step=2)
                if terminal == "completed":
                    reporter.finish()
                else:
                    reporter.fail(KeyboardInterrupt() if terminal == "stopped" else RuntimeError("synthetic failure"))
                before = self.read_state()
                with self.assertRaises(RuntimeError):
                    reporter.emit("rollout", status="running")
                reporter.fail(RuntimeError("later error"))
                self.assertEqual(self.read_state(), before)
                self.assertEqual(before["status"], terminal)

    def test_completed_steps_cannot_regress(self):
        reporter = runtime.RuntimeReporter(str(self.root), instance_id="one")
        reporter.emit("validation", last_completed_step=2)
        before = self.read_state()
        with self.assertRaises(ValueError):
            reporter.emit("rollout", last_completed_step=1)
        self.assertEqual(self.read_state(), before)
        self.assertEqual(reporter.sequence, before["sequence"])

    def test_failed_write_does_not_advance_reporter_state(self):
        reporter = runtime.RuntimeReporter(str(self.root), instance_id="one")
        reporter.emit("rollout", last_completed_step=1)
        before = self.read_state()
        output = self.output.getvalue()
        with patch.object(runtime, "atomic_json_write", side_effect=OSError("synthetic write failure")):
            with self.assertRaises(OSError):
                reporter.emit("validation", last_completed_step=2)
        self.assertEqual(self.read_state(), before)
        self.assertEqual(self.output.getvalue(), output)
        self.assertEqual(reporter.state, before)
        self.assertEqual(reporter.sequence, before["sequence"])

    def test_first_snapshot_has_required_fields_without_a_checkpoint(self):
        reporter = runtime.RuntimeReporter(str(self.root), instance_id="new")
        state = reporter.emit("baseline")
        self.assertEqual(state["sequence"], 1)
        self.assertEqual(state["status"], "running")
        for key in ("last_completed_step", "current_step", "total_steps"):
            self.assertEqual(state[key], 0)
        for key in ("current_score", "best_score"):
            self.assertIsNone(state[key])
        self.assertTrue(state["updated_at"])
        self.assertTrue(state["recipe_hash"])
        self.assertNotIn("current_skill_path", state)
        self.assertNotIn("best_skill_path", state)

    def test_failure_before_first_emit_has_complete_snapshot_without_checkpoint(self):
        reporter = runtime.RuntimeReporter(str(self.root), instance_id="new")
        reporter.fail(RuntimeError("synthetic initialization failure"))
        state = self.read_state()
        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["phase"], "failed")
        self.assertEqual(state["sequence"], 1)
        self.assertEqual(state["last_completed_step"], 0)
        self.assertEqual(state["current_step"], 0)
        self.assertEqual(state["total_steps"], 0)
        self.assertIsNone(state["current_score"])
        self.assertIsNone(state["best_score"])
        self.assertTrue(state["updated_at"])
        self.assertTrue(state["recipe_hash"])
        self.assertNotIn("current_skill_path", state)
        self.assertNotIn("best_skill_path", state)

    def test_non_object_checkpoint_is_rejected(self):
        self.path.write_text("[]")
        with self.assertRaisesRegex(ValueError, "must contain an object"):
            runtime.RuntimeReporter(str(self.root))


if __name__ == "__main__":
    unittest.main()
