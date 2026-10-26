import json
import tempfile
import unittest
import warnings
from pathlib import Path
from unittest.mock import patch

from scripts.eval_only import evaluate_splits, parse_args
from skillopt.datasets.base import SplitDataLoader


class DatasetTests(unittest.TestCase):
    def write_splits(self, directory, splits):
        for name, items in splits.items():
            path = Path(directory) / name
            path.mkdir()
            (path / "items.json").write_text(json.dumps(items), encoding="utf-8")

    def test_document_overlap_is_reported_without_rewriting_data(self):
        with tempfile.TemporaryDirectory() as directory:
            splits = {
                "train": [{"id": "a", "question": "one", "docId": "doc"}],
                "val": [{"id": "b", "question": "two", "docId": "doc"}],
                "test": [{"id": "c", "question": "three", "docId": "other"}],
            }
            self.write_splits(directory, splits)
            loader = SplitDataLoader(split_dir=directory, split_mode="split_dir")
            with warnings.catch_warnings(record=True) as captured:
                warnings.simplefilter("always")
                loader.setup({})
            self.assertEqual(len(captured), 1)
            self.assertIn("train/val share 1", str(captured[0].message))
            self.assertEqual(loader.train_items, splits["train"])
            self.assertEqual(json.loads((Path(directory) / "val/items.json").read_text()), splits["val"])

    def test_invalid_rule_schema_rejected_by_loader(self):
        with tempfile.TemporaryDirectory() as directory:
            self.write_splits(directory, {name: [{"id": name, "forbidden_terms": "not a list"}] for name in ("train", "val", "test")})
            with self.assertRaisesRegex(ValueError, "forbidden_terms"):
                SplitDataLoader(split_dir=directory, split_mode="split_dir").setup({})

    def test_empty_test_requires_explicit_disable(self):
        with tempfile.TemporaryDirectory() as directory:
            self.write_splits(directory, {"train": [{"id": "a"}], "val": [{"id": "b"}], "test": []})
            with self.assertRaisesRegex(ValueError, "test.*empty"):
                SplitDataLoader(split_dir=directory, split_mode="split_dir").setup({})
            loader = SplitDataLoader(split_dir=directory, split_mode="split_dir")
            loader.setup({"eval_test": False})
            self.assertEqual(loader.test_items, [])

    def test_tiny_ratio_split_fails_without_creating_split_files(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "input.json"
            data.write_text(json.dumps([{"id": "one"}, {"id": "two"}]))
            output = Path(directory) / "generated"
            loader = SplitDataLoader(data_path=str(data), split_output_dir=str(output))
            with self.assertRaisesRegex(ValueError, "empty split"):
                loader.setup({})
            self.assertFalse(output.exists())

    def test_eval_default_is_held_out(self):
        with patch("sys.argv", ["eval", "--config", "config.yaml", "--skill", "skill.md"]):
            self.assertEqual(parse_args().split, "valid_unseen")

    def test_all_evaluation_keeps_split_scores_and_duplicate_ids_separate(self):
        class Adapter:
            def __init__(self):
                self.calls = []

            def build_eval_env(self, count, split, seed):
                return [{"id": "same", "split": split}]

            def rollout(self, items, skill, output):
                self.calls.append((items[0]["split"], output))
                score = int(items[0]["split"] == "train")
                return [{"id": "same", "hard": score, "soft": score, "agent_ok": True}]

        adapter = Adapter()
        with tempfile.TemporaryDirectory() as directory:
            result = evaluate_splits(adapter, "skill", directory, "all", 42)
        self.assertEqual(result["n_items"], 3)
        self.assertNotIn("hard", result)
        self.assertEqual(result["splits"]["train"]["hard"], 1)
        self.assertEqual(result["splits"]["valid_unseen"]["hard"], 0)
        self.assertEqual(len({output for _, output in adapter.calls}), 3)


if __name__ == "__main__":
    unittest.main()
