import ast
import importlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from skillopt.utils.rollout_cache import RolloutCacheError, prepare_rollout_cache
from skillopt.utils.scoring import IncompleteEvaluationError


MODEL = {"backend": "openai_chat", "model": "synthetic", "temperature": 0}


class RolloutCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = self.temp.name
        self.items = [{"id": "a", "question": "q", "answers": ["answer"]}]

    def prepare(self, items=None, skill="skill", config=None):
        return prepare_rollout_cache(self.directory, self.items if items is None else items, skill, {}, model_config=MODEL if config is None else config)

    def append(self, rows):
        with (Path(self.directory) / "results.jsonl").open("a", encoding="utf-8") as stream:
            for row in rows:
                stream.write(json.dumps(row) + "\n")

    def test_matching_recipe_resumes_and_filters_unrelated_rows(self):
        self.prepare()
        self.append([{"id": "other", "hard": 0, "soft": 0}, {"id": "a", "hard": 1, "soft": 1}])
        _, existing, pending = self.prepare()
        self.assertEqual([row["id"] for row in existing], ["a"])
        self.assertEqual(pending, [])

    def test_changed_skill_model_data_or_constraints_are_rejected(self):
        self.prepare()
        self.append([{"id": "a", "hard": 1, "soft": 1}])
        for kwargs in (
            {"skill": "new skill"},
            {"config": {**MODEL, "temperature": 1}},
            {"items": [{**self.items[0], "question": "changed"}]},
            {"items": [{**self.items[0], "forbidden_terms": ["到账"]}]},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(RolloutCacheError):
                self.prepare(**kwargs)
        self.assertTrue((Path(self.directory) / "results.jsonl").exists())

    def test_old_unversioned_results_are_preserved_and_rejected(self):
        self.append([{"id": "a", "hard": 1, "soft": 1}])
        before = (Path(self.directory) / "results.jsonl").read_bytes()
        with self.assertRaisesRegex(RolloutCacheError, "Unversioned"):
            self.prepare()
        self.assertEqual((Path(self.directory) / "results.jsonl").read_bytes(), before)
        self.assertFalse((Path(self.directory) / "rollout_manifest.json").exists())

    def test_failed_executions_are_retried_without_duplicating_scores(self):
        self.prepare()
        self.append([{"id": "a", "hard": 0, "soft": 0, "agent_ok": False}])
        _, existing, pending = self.prepare()
        self.assertEqual(existing, [])
        self.assertEqual(pending, self.items)
        self.append([{"id": "a", "hard": 1, "soft": 1, "agent_ok": True}])
        _, existing, pending = self.prepare()
        self.assertEqual(len(existing), 1)
        self.assertEqual(existing[0]["hard"], 1)
        self.assertEqual(pending, [])

    def test_duplicate_ids_and_corrupt_results_rejected(self):
        with self.assertRaisesRegex(RolloutCacheError, "Duplicate"):
            self.prepare(items=self.items * 2)
        self.prepare()
        (Path(self.directory) / "results.jsonl").write_text("broken", encoding="utf-8")
        with self.assertRaisesRegex(RolloutCacheError, "Invalid cached result"):
            self.prepare()

    def test_document_bytes_are_part_of_fingerprint(self):
        path = Path(self.directory) / "document.png"
        path.write_bytes(b"original")
        items = [{**self.items[0], "image_path": str(path)}]
        self.prepare(items=items)
        path.write_bytes(b"changed")
        with self.assertRaises(RolloutCacheError):
            self.prepare(items=items)

    def test_manifest_does_not_include_input_text_or_model_endpoint(self):
        self.prepare()
        text = (Path(self.directory) / "rollout_manifest.json").read_text()
        self.assertNotIn("synthetic", text)
        self.assertNotIn("question", text)

    def test_all_json_rollouts_enforce_fingerprint_before_model(self):
        calls = [
            ("searchqa", "run_batch", {}),
            ("docvqa", "run_batch", {}),
            ("livemathematicianbench", "run_batch", {}),
            ("officeqa", "run_batch", {"data_dirs": [self.directory]}),
            ("spreadsheetbench", "run_spreadsheet_batch", {"data_root": self.directory}),
            ("spreadsheetbench", "run_spreadsheet_batch_codegen", {"data_root": self.directory}),
        ]
        for env, name, kwargs in calls:
            module = importlib.import_module(f"skillopt.envs.{env}.rollout")
            with self.subTest(env=env, name=name), tempfile.TemporaryDirectory() as directory, \
                    patch("skillopt.utils.rollout_cache.target_runtime_config", return_value=MODEL), \
                    patch.object(module, "process_one", return_value={"id": "a", "hard": 1, "soft": 1, "agent_ok": True}) as process:
                codegen_patch = patch.object(module, "process_one_codegen", return_value={"id": "a", "hard": 1, "soft": 1, "llm_ok": True}) if env == "spreadsheetbench" else patch.object(module, "process_one", process)
                with codegen_patch:
                    runner = getattr(module, name)
                    result = runner(items=self.items, out_root=directory, skill_content="skill", **kwargs)
                    self.assertEqual(result[0]["hard"], 1)
                    runner(items=self.items, out_root=directory, skill_content="skill", **kwargs)
                    with self.assertRaises(RolloutCacheError):
                        runner(items=self.items, out_root=directory, skill_content="changed", **kwargs)

    def test_partial_gateway_failure_is_written_but_not_scored(self):
        module = importlib.import_module("skillopt.envs.searchqa.rollout")
        items = [*self.items, {"id": "b", "question": "q2", "answers": ["a2"]}]

        def process(item, *args, **kwargs):
            ok = item["id"] == "a"
            return {"id": item["id"], "hard": int(ok), "soft": float(ok), "agent_ok": ok}

        with patch("skillopt.utils.rollout_cache.target_runtime_config", return_value=MODEL), patch.object(module, "process_one", side_effect=process):
            with self.assertRaises(IncompleteEvaluationError) as caught:
                module.run_batch(items, self.directory, "skill")
        self.assertEqual(caught.exception.coverage["coverage"], 0.5)
        self.assertEqual(len((Path(self.directory) / "results.jsonl").read_text().splitlines()), 2)

    def test_alfworld_existing_results_refused_without_loading_simulator(self):
        source = Path(__file__).parents[1] / "skillopt/envs/alfworld/adapter.py"
        tree = ast.parse(source.read_text())
        method = next(node for cls in tree.body if isinstance(cls, ast.ClassDef) and cls.name == "ALFWorldAdapter" for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == "rollout")
        namespace = {"os": os}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(source), "exec"), namespace)
        self.append([{"id": "old", "hard": 1, "soft": 1}])
        with self.assertRaisesRegex(ValueError, "simulator fingerprint"):
            namespace["rollout"](SimpleNamespace(), object(), "new skill", self.directory)
        self.assertTrue((Path(self.directory) / "results.jsonl").exists())

    def test_spreadsheet_retry_preserves_failed_rows_and_scores_success_once(self):
        from skillopt.envs.spreadsheetbench.adapter import SpreadsheetBenchAdapter

        adapter = SimpleNamespace(mode="single", data_root=self.directory, max_turns=1, max_completion_tokens=10, workers=1, exec_timeout=1)
        with patch("skillopt.utils.rollout_cache.target_runtime_config", return_value=MODEL), \
                patch("skillopt.envs.spreadsheetbench.rollout.process_one_codegen", side_effect=[
                    {"id": "a", "hard": 0, "soft": 0, "llm_ok": False},
                    {"id": "a", "hard": 1, "soft": 1, "llm_ok": True},
                ]) as process:
            with self.assertRaises(IncompleteEvaluationError):
                SpreadsheetBenchAdapter.rollout(adapter, self.items, "skill", self.directory)
            results = SpreadsheetBenchAdapter.rollout(adapter, self.items, "skill", self.directory)
            resumed = SpreadsheetBenchAdapter.rollout(adapter, self.items, "skill", self.directory)
        self.assertEqual(process.call_count, 2)
        self.assertEqual(len(results), 1)
        self.assertEqual(resumed, results)
        rows = [json.loads(line) for line in (Path(self.directory) / "results.jsonl").read_text().splitlines()]
        self.assertEqual([row["llm_ok"] for row in rows], [False, True])

    def test_spreadsheet_adapter_does_not_short_circuit_validation(self):
        from skillopt.envs.spreadsheetbench.adapter import SpreadsheetBenchAdapter

        self.append([{"id": "old", "hard": 1, "soft": 1}])
        adapter = SimpleNamespace(mode="single", data_root=self.directory, max_turns=1, max_completion_tokens=10, workers=1, exec_timeout=1)
        with patch("skillopt.envs.spreadsheetbench.adapter.run_spreadsheet_batch_codegen", side_effect=RolloutCacheError("untrusted cache")) as runner:
            with self.assertRaises(RolloutCacheError):
                SpreadsheetBenchAdapter.rollout(adapter, self.items, "new skill", self.directory)
        runner.assert_called_once()


if __name__ == "__main__":
    unittest.main()
