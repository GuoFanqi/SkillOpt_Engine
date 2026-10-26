from contextlib import ExitStack, redirect_stdout
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from skillopt.engine import trainer as trainer_module
from skillopt.engine.runtime import STATE_PREFIX
from skillopt.envs.base import EnvAdapter
from skillopt.gradient.reflect import ReflectionError
from skillopt.utils import skill_hash


class FakeAdapter(EnvAdapter):
    def __init__(self, *, score=None, no_edits=False, appendix=False, fail_reflect=None, fail_phase=None):
        self.score = score or self.default_score
        self.no_edits = no_edits
        self.appendix = appendix
        self.fail_reflect = fail_reflect
        self.fail_phase = fail_phase
        self.reflect_calls = 0
        self.calls = []

    @staticmethod
    def default_score(content):
        if "SLOW_SIGNAL" in content or "APPENDIX_SIGNAL" in content:
            return 0.25, 0.9
        if "PATCH_" in content:
            return 0.5, 0.8
        return 0.0, 0.2

    def build_train_env(self, batch_size, seed, **kwargs):
        return [{"id": str(i), "task_type": "synthetic", "question": "synthetic question"} for i in range(4)]

    def build_eval_env(self, env_num, split, seed, **kwargs):
        return self.build_train_env(4, seed)

    def rollout(self, env_manager, skill_content, out_dir, **kwargs):
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        state = json.loads((Path(self._cfg["out_root"]) / "runtime_state.json").read_text())
        self.calls.append({"state": state, "content": skill_content, "out_dir": str(out_dir)})
        if state["phase"] == self.fail_phase:
            raise RuntimeError("synthetic evaluation failure")
        hard, soft = self.score(skill_content)
        return [
            {**item, "hard": int(i < round(hard * 4)), "soft": soft, "agent_ok": True, "response": "synthetic answer"}
            for i, item in enumerate(env_manager)
        ]

    def reflect(self, results, skill_content, out_dir, **kwargs):
        self.reflect_calls += 1
        if self.reflect_calls == self.fail_reflect:
            raise ReflectionError("synthetic reflection failure")
        edits = [] if self.no_edits else [{"op": "append", "content": f"PATCH_{self.reflect_calls}"}]
        result = {"source_type": "failure", "patch": {"edits": edits}}
        if self.appendix:
            result["appendix_notes"] = ["APPENDIX_SIGNAL"]
        return [result]

    def get_task_types(self):
        return ["synthetic"]


class TrainerRuntimeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.initial = self.root / "initial.md"
        self.initial.write_text("BASE_SKILL\n")
        self.output = io.StringIO()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(redirect_stdout(self.output))
        self.stack.enter_context(patch.dict(os.environ))
        for name in (
            "configure_azure_openai", "configure_claude_code_exec", "configure_codex_exec",
            "configure_minimax_chat", "configure_qwen_chat", "set_reasoning_effort",
            "set_target_backend", "set_target_deployment", "set_optimizer_backend",
            "set_optimizer_deployment", "reset_token_tracker", "configure_skill_aware_reflection",
        ):
            self.stack.enter_context(patch.object(trainer_module, name))
        self.stack.enter_context(patch.object(trainer_module, "get_token_summary", return_value={}))
        self.stack.enter_context(patch.object(trainer_module, "chat_optimizer", side_effect=AssertionError("Real model requests are forbidden in this test")))
        self.stack.enter_context(patch.object(trainer_module, "merge_patches", side_effect=lambda skill, failures, successes, **kwargs: deepcopy((failures + successes)[0])))
        self.stack.enter_context(patch.object(trainer_module, "rank_and_select", side_effect=lambda skill, merged, **kwargs: deepcopy(merged)))
        self.slow = self.stack.enter_context(patch.object(trainer_module, "run_slow_update", return_value={"slow_update_content": "SLOW_SIGNAL"}))
        self.meta = self.stack.enter_context(patch.object(trainer_module, "run_meta_skill", return_value={"meta_skill_content": "synthetic optimizer memory"}))
        self.stack.enter_context(patch.object(trainer_module, "rewrite_skill_from_suggestions", side_effect=AssertionError("Unexpected rewrite model request")))
        self.stack.enter_context(patch.object(trainer_module, "decide_autonomous_learning_rate", side_effect=AssertionError("Unexpected autonomous model request")))
        self.stack.enter_context(patch.object(trainer_module, "consolidate_appendix_notes", side_effect=AssertionError("Unexpected appendix model request")))

    def config(self, name="run", **overrides):
        cfg = {
            "out_root": str(self.root / name), "skill_init": str(self.initial),
            "env": "synthetic", "model_backend": "openai_chat", "optimizer_backend": "openai_chat",
            "target_backend": "openai_chat", "optimizer_model": "synthetic", "target_model": "synthetic",
            "batch_size": 4, "train_size": 4, "num_epochs": 1, "accumulation": 1, "seed": 7,
            "merge_batch_size": 2, "analyst_workers": 1, "edit_budget": 1, "min_edit_budget": 1,
            "lr_scheduler": "constant", "sel_env_num": 4, "test_env_num": 4, "eval_test": True,
            "use_gate": True, "gate_metric": "soft", "use_slow_update": False, "use_meta_skill": False,
        }
        cfg.update(overrides)
        return cfg

    def snapshots(self):
        return [json.loads(line[len(STATE_PREFIX):]) for line in self.output.getvalue().splitlines() if line.startswith(STATE_PREFIX)]

    def read(self, cfg, name):
        return json.loads((Path(cfg["out_root"]) / name).read_text())

    def train(self, cfg, adapter):
        return trainer_module.ReflACTTrainer(cfg, adapter).train()

    def test_every_snapshot_has_required_protocol_fields_from_the_first_baseline(self):
        self.train(self.config(), FakeAdapter())
        snapshots = self.snapshots()
        self.assertEqual(snapshots[0]["phase"], "baseline")
        self.assertEqual(snapshots[0]["last_completed_step"], 0)
        required = {
            "instance_id", "sequence", "status", "phase", "current_step", "last_completed_step",
            "total_steps", "current_score", "best_score", "updated_at", "recipe_hash",
        }
        for snapshot in snapshots:
            with self.subTest(phase=snapshot["phase"], sequence=snapshot["sequence"]):
                self.assertTrue(required.issubset(snapshot))
                for key in ("sequence", "current_step", "last_completed_step", "total_steps"):
                    self.assertIs(type(snapshot[key]), int)
                    self.assertGreaterEqual(snapshot[key], 0)
                for key in ("current_score", "best_score"):
                    if snapshot[key] is not None:
                        self.assertGreaterEqual(snapshot[key], 0)
                        self.assertLessEqual(snapshot[key], 1)
                self.assertTrue(snapshot["instance_id"])
                self.assertTrue(snapshot["updated_at"])
                self.assertTrue(snapshot["recipe_hash"])

    def test_real_node_parser_accepts_every_python_snapshot(self):
        server = Path(__file__).resolve().parents[1] / "web/server"
        node = shutil.which("node")
        if not node or not (server / "node_modules/tsx").is_dir():
            self.skipTest("Node.js and the local server tsx dependency are required")
        self.train(self.config(), FakeAdapter())
        recovery_cfg = self.config(name="parser-initialization-recovery", eval_test=False)
        with patch.object(trainer_module, "configure_azure_openai", side_effect=RuntimeError("synthetic initialization failure")):
            with self.assertRaises(RuntimeError):
                self.train(recovery_cfg, FakeAdapter())
        self.train(recovery_cfg, FakeAdapter())
        snapshots = self.snapshots()
        script = (
            "import { readFileSync } from 'node:fs';"
            "import { parseTrainerSnapshot } from './src/run-state.ts';"
            "const rows = JSON.parse(readFileSync(0, 'utf8'));"
            "for (const row of rows) parseTrainerSnapshot(JSON.stringify(row), row.instance_id);"
            "process.stdout.write(String(rows.length));"
        )
        result = subprocess.run(
            [node, "--import", "tsx/esm", "--input-type=module", "-e", script],
            cwd=server, input=json.dumps(snapshots), text=True, capture_output=True, timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, str(len(snapshots)))

    def test_initialization_failure_can_restart_without_checkpoint_files(self):
        for failure in ("adapter", "model"):
            with self.subTest(failure=failure):
                cfg = self.config(name=f"initialization-{failure}", eval_test=False)
                adapter = FakeAdapter()
                target = adapter if failure == "adapter" else trainer_module
                name = "setup" if failure == "adapter" else "configure_azure_openai"
                with patch.object(target, name, side_effect=RuntimeError("synthetic initialization failure")):
                    with self.assertRaisesRegex(RuntimeError, "synthetic initialization failure"):
                        self.train(cfg, adapter)
                failed = self.read(cfg, "runtime_state.json")
                self.assertEqual(failed["status"], "failed")
                self.assertEqual(failed["last_completed_step"], 0)
                self.assertNotIn("current_skill_path", failed)
                self.assertNotIn("best_skill_path", failed)
                self.assertFalse((Path(cfg["out_root"]) / "skills").exists())
                self.output.seek(0)
                self.output.truncate(0)
                recovered = FakeAdapter()
                self.train(cfg, recovered)
                first = self.snapshots()[0]
                self.assertEqual(first["phase"], "baseline")
                self.assertEqual(first["last_completed_step"], 0)
                self.assertNotEqual(first["instance_id"], failed["instance_id"])
                self.assertTrue(any(call["content"] == self.initial.read_text() for call in recovered.calls))
                self.assertEqual(self.read(cfg, "runtime_state.json")["status"], "completed")

    def test_two_epoch_resume_does_not_overwrite_earlier_skill_versions(self):
        cfg = self.config(num_epochs=2, train_size=8, use_gate=False, use_slow_update=True, slow_update_samples=2, eval_test=False)
        self.train(cfg, FakeAdapter())
        run = Path(cfg["out_root"])
        original = {path.name: path.read_bytes() for path in (run / "skills").glob("skill_v*.md")}
        self.assertNotEqual(original["skill_v0002.md"], original["skill_v0004.md"])
        self.assertEqual(self.read(cfg, "runtime_state.json")["last_completed_step"], 4)
        self.output.seek(0)
        self.output.truncate(0)
        self.slow.reset_mock()
        resumed = FakeAdapter()
        self.train(cfg, resumed)
        self.assertEqual(resumed.reflect_calls, 0)
        self.slow.assert_not_called()
        for name, content in original.items():
            self.assertEqual((run / "skills" / name).read_bytes(), content, name)
        self.assertTrue(all(snapshot["last_completed_step"] == 4 for snapshot in self.snapshots()))
        self.assertEqual(self.read(cfg, "runtime_state.json")["status"], "completed")

    def test_resume_at_epoch_end_finishes_pending_slow_update(self):
        cfg = self.config(num_epochs=2, train_size=8, use_gate=False, use_slow_update=True, slow_update_samples=2, eval_test=False)
        self.slow.side_effect = RuntimeError("synthetic interrupted epoch finalization")
        with self.assertRaisesRegex(RuntimeError, "synthetic interrupted epoch finalization"):
            self.train(cfg, FakeAdapter())
        run = Path(cfg["out_root"])
        old_epoch_skill = (run / "skills/skill_v0002.md").read_bytes()
        pre_slow_skill = (run / "skills/skill_v0004.md").read_text()
        self.assertEqual(self.read(cfg, "runtime_state.json")["last_completed_step"], 4)
        self.assertFalse((run / "slow_update/epoch_02/slow_result.json").exists())
        self.assertNotIn("SLOW_SIGNAL", pre_slow_skill)
        self.output.seek(0)
        self.output.truncate(0)
        self.slow.side_effect = None
        self.slow.reset_mock()
        resumed = FakeAdapter()
        self.train(cfg, resumed)
        self.assertEqual(resumed.reflect_calls, 0)
        self.slow.assert_called_once()
        self.assertEqual((run / "skills/skill_v0002.md").read_bytes(), old_epoch_skill)
        self.assertIn("SLOW_SIGNAL", (run / "skills/skill_v0004.md").read_text())
        self.assertEqual(self.read(cfg, "slow_update/epoch_02/slow_result.json")["action"], "force_accept")
        self.assertTrue(all(snapshot["last_completed_step"] == 4 for snapshot in self.snapshots()))
        self.assertEqual(self.read(cfg, "runtime_state.json")["status"], "completed")

    def test_completion_follows_all_final_evaluations(self):
        def score(content):
            if "PATCH_2" in content:
                return 0.25, 0.6
            if "PATCH_1" in content:
                return 0.75, 0.9
            return 0.0, 0.2

        cfg = self.config(num_epochs=2, use_gate=False)
        adapter = FakeAdapter(score=score)
        self.train(cfg, adapter)
        snapshots = self.snapshots()
        phases = [state["phase"] for state in snapshots]
        expected = ["baseline", "rollout", "reflect", "aggregate", "select", "update", "validation", "final_validation", "baseline_test", "best_test", "final_test", "finalizing", "completed"]
        for phase in expected:
            self.assertIn(phase, phases)
        self.assertEqual(phases[-1], "completed")
        self.assertTrue(all(state["status"] == "running" for state in snapshots[:-1]))
        self.assertEqual([call["state"]["phase"] for call in adapter.calls if call["state"]["phase"].endswith("_test")], ["baseline_test", "best_test", "final_test"])
        for call in adapter.calls:
            self.assertEqual(call["state"]["status"], "running")
        for state in snapshots:
            self.assertLessEqual(state.get("last_completed_step", 0), state["current_step"])
            self.assertLessEqual(state["current_step"], state["total_steps"])
        self.assertEqual(snapshots[-1]["last_completed_step"], 2)
        self.assertEqual(snapshots[-1]["total_steps"], 2)
        self.assertEqual(self.read(cfg, "summary.json")["status"], "completed")

    def test_final_test_failure_cannot_report_completed(self):
        def score(content):
            return (0.25, 0.5) if "PATCH_2" in content else ((0.75, 0.9) if "PATCH_1" in content else (0.0, 0.2))

        cfg = self.config(num_epochs=2, use_gate=False)
        with self.assertRaisesRegex(RuntimeError, "synthetic evaluation failure"):
            self.train(cfg, FakeAdapter(score=score, fail_phase="final_test"))
        snapshots = self.snapshots()
        self.assertEqual(snapshots[-1]["status"], "failed")
        self.assertEqual(snapshots[-1]["last_completed_step"], 2)
        self.assertFalse(any(state["status"] == "completed" for state in snapshots))
        self.assertFalse((Path(cfg["out_root"]) / "summary.json").exists())

    def test_reflection_failure_does_not_advance_checkpoint(self):
        cfg = self.config(num_epochs=2)
        with self.assertRaises(ReflectionError):
            self.train(cfg, FakeAdapter(fail_reflect=2))
        state = self.read(cfg, "runtime_state.json")
        self.assertEqual(state["status"], "failed")
        self.assertEqual(state["current_step"], 2)
        self.assertEqual(state["last_completed_step"], 1)
        self.assertEqual(len(self.read(cfg, "history.json")), 1)
        self.assertFalse((Path(cfg["out_root"]) / "skills/skill_v0002.md").exists())
        self.assertFalse(any(snapshot["status"] == "completed" for snapshot in self.snapshots()))

    def test_zero_score_resume_keeps_checkpoint_and_does_not_repeat_baseline(self):
        cfg = self.config(num_epochs=2, eval_test=False)
        with self.assertRaises(ReflectionError):
            self.train(cfg, FakeAdapter(score=lambda content: (0.0, 0.0), no_edits=True, fail_reflect=2))
        before = self.read(cfg, "runtime_state.json")
        self.assertEqual(before["current_score"], 0.0)
        self.assertEqual(before["last_completed_step"], 1)
        self.output.seek(0)
        self.output.truncate(0)
        resumed = FakeAdapter(score=lambda content: (0.0, 0.0), no_edits=True)
        summary = self.train(cfg, resumed)
        snapshots = self.snapshots()
        self.assertFalse(any(state["phase"] == "baseline" for state in snapshots))
        self.assertFalse(any(Path(call["out_dir"]).name == "selection_eval_baseline" for call in resumed.calls))
        self.assertTrue(all(state.get("last_completed_step", 0) >= 1 for state in snapshots))
        self.assertNotEqual(snapshots[0]["instance_id"], before["instance_id"])
        self.assertEqual(snapshots[0]["sequence"], 1)
        self.assertEqual(snapshots[-1]["last_completed_step"], 2)
        self.assertEqual(summary["best_selection_hard"], 0.0)
        self.assertEqual(summary["best_selection_score"], 0.0)

    def test_soft_and_mixed_scores_are_not_reported_as_hard(self):
        for metric, expected in (("soft", 0.8), ("mixed", 0.65)):
            with self.subTest(metric=metric):
                cfg = self.config(name=metric, gate_metric=metric, gate_mixed_weight=0.5)
                summary = self.train(cfg, FakeAdapter())
                state = self.read(cfg, "runtime_state.json")
                self.assertAlmostEqual(summary["best_selection_score"], expected)
                self.assertAlmostEqual(summary["best_selection_hard"], 0.5)
                self.assertAlmostEqual(summary["best_selection_soft"], 0.8)
                self.assertAlmostEqual(summary["final_selection_hard"], 0.5)
                self.assertAlmostEqual(summary["final_selection_soft"], 0.8)
                self.assertAlmostEqual(state["current_hard"], 0.5)
                self.assertAlmostEqual(state["current_soft"], 0.8)

    def test_appendix_updates_have_their_own_measurements(self):
        for no_edits in (False, True):
            with self.subTest(no_edits=no_edits):
                cfg = self.config(name=f"appendix-{no_edits}", use_skill_aware_reflection=True, eval_test=False)
                adapter = FakeAdapter(no_edits=no_edits, appendix=True)
                summary = self.train(cfg, adapter)
                state = self.read(cfg, "runtime_state.json")
                self.assertAlmostEqual(state["current_hard"], 0.25)
                self.assertAlmostEqual(state["current_soft"], 0.9)
                self.assertAlmostEqual(state["current_score"], 0.9)
                self.assertAlmostEqual(summary["final_selection_hard"], 0.25)
                self.assertTrue(any("APPENDIX_SIGNAL" in call["content"] and call["state"]["phase"] == "validation" for call in adapter.calls))
                self.assertEqual(state["current_skill_hash"], skill_hash(Path(state["current_skill_path"]).read_text()))

    def test_force_slow_update_is_reevaluated_and_meta_phase_is_visible(self):
        cfg = self.config(num_epochs=2, use_slow_update=True, slow_update_gate_with_selection=False, slow_update_samples=2, use_meta_skill=True, eval_test=False)
        adapter = FakeAdapter()
        summary = self.train(cfg, adapter)
        state = self.read(cfg, "runtime_state.json")
        phases = {snapshot["phase"] for snapshot in self.snapshots()}
        self.assertIn("slow_update", phases)
        self.assertIn("meta_skill", phases)
        self.slow.assert_called_once()
        self.meta.assert_called_once()
        self.assertEqual(self.read(cfg, "slow_update/epoch_02/slow_result.json")["action"], "force_accept")
        self.assertAlmostEqual(state["current_hard"], 0.25)
        self.assertAlmostEqual(state["current_soft"], 0.9)
        self.assertAlmostEqual(state["current_score"], 0.9)
        self.assertAlmostEqual(summary["best_selection_hard"], 0.5)
        self.assertTrue(any("SLOW_SIGNAL" in call["content"] and call["state"]["phase"] == "validation" for call in adapter.calls))
        self.assertEqual(state["current_skill_hash"], skill_hash(Path(state["current_skill_path"]).read_text()))

    def test_changed_recipe_does_not_reuse_previous_measurements(self):
        cfg = self.config(eval_test=False)
        first = self.train(cfg, FakeAdapter())
        previous_recipe = first["recipe_hash"]
        cfg["target_model"] = "synthetic-new-model"
        adapter = FakeAdapter(score=lambda content: (0.25, 0.1))
        second = self.train(cfg, adapter)
        self.assertNotEqual(second["recipe_hash"], previous_recipe)
        self.assertTrue(any("selection_recheck" in call["out_dir"] for call in adapter.calls))
        self.assertAlmostEqual(second["best_selection_hard"], 0.25)
        self.assertAlmostEqual(second["best_selection_soft"], 0.1)


if __name__ == "__main__":
    unittest.main()
