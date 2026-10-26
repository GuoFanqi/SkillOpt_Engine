import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from skillopt.config import apply_overrides, flatten_config, load_config
from skillopt.model import backend_config


ROOT = Path(__file__).resolve().parents[1]


class ConfigTests(unittest.TestCase):
    def test_builtin_defaults_keep_models_with_supported_backends(self):
        for name in ("_base_", "alfworld", "searchqa", "docvqa", "officeqa", "livemathematicianbench", "spreadsheetbench"):
            with self.subTest(name=name):
                cfg = flatten_config(load_config(str(ROOT / "configs" / name / "default.yaml")))
                self.assertEqual(cfg["optimizer_backend"], "openai_chat")
                self.assertEqual(cfg["target_backend"], "openai_chat")
                self.assertEqual(cfg["optimizer_model"], "deepseek-chat")
                self.assertEqual(cfg["target_model"], "deepseek-chat")

    def test_all_repository_yaml_configs_can_be_flattened(self):
        paths = sorted((ROOT / "configs").rglob("*.yaml"))
        self.assertTrue(paths)
        for path in paths:
            with self.subTest(path=path.relative_to(ROOT)):
                cfg = flatten_config(load_config(str(path)))
                self.assertNotIn("_base_", cfg)
                self.assertIn("optimizer_model", cfg)

    def test_yaml_unknown_section_fields_fail_without_cli_overrides(self):
        for section in ("model", "train", "gradient", "optimizer", "evaluation"):
            with self.subTest(section=section), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "config.yaml"
                path.write_text(f"{section}:\n  misspelled_option: 1\n")
                with self.assertRaisesRegex(ValueError, f"{section}.misspelled_option"):
                    flatten_config(load_config(str(path)))

    def test_yaml_non_mapping_sections_are_rejected(self):
        for section in ("model", "train", "gradient", "optimizer", "evaluation", "env"):
            for value in (None, 3, "invalid", []):
                with self.subTest(section=section, value=value), self.assertRaisesRegex(ValueError, "must be a mapping"):
                    flatten_config({"train": {}, section: value})
        for section in ("model", "train", "gradient", "optimizer", "evaluation"):
            with self.subTest(section=section), self.assertRaisesRegex(ValueError, "must be a mapping"):
                flatten_config({section: "invalid"})

    def test_yaml_root_must_be_a_mapping(self):
        for content in ("[]", "false", "3", "invalid"):
            with self.subTest(content=content), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "config.yaml"
                path.write_text(content)
                with self.assertRaisesRegex(ValueError, "must contain a mapping"):
                    load_config(str(path))

    def test_unknown_top_level_structured_options_are_rejected(self):
        for key in ("modle", "epochs", "num_epochs", "eval_test", "out_root", "metadata"):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "Unknown top-level option"):
                flatten_config({"train": {"num_epochs": 2}, key: "value"})

    def test_only_explicit_ui_metadata_is_preserved(self):
        flat = flatten_config({"trainingName": "synthetic training", "train": {"num_epochs": 2}, "env": {"custom_option": 7}})
        self.assertEqual(flat, {"trainingName": "synthetic training", "num_epochs": 2, "custom_option": 7})

    def test_flat_environment_name_remains_supported(self):
        self.assertEqual(flatten_config({"env": "searchqa", "num_epochs": 2}), {"env": "searchqa", "num_epochs": 2})

    def test_structured_overrides_preserve_types_and_env_options(self):
        cfg = {"train": {"num_epochs": 4}}
        apply_overrides(cfg, ["train.num_epochs=9", "evaluation.use_gate=false", "env.custom_option=7"])
        flat = flatten_config(cfg)
        self.assertEqual(flat["num_epochs"], 9)
        self.assertIs(flat["use_gate"], False)
        self.assertEqual(flat["custom_option"], 7)

    def test_invalid_structured_override_is_rejected(self):
        for option in ("num_epochs=9", "train.num_epoch=9", "modle.target=example", "env.=x", "model.target.name=x", "=x"):
            with self.subTest(option=option), self.assertRaises(ValueError):
                apply_overrides({"train": {"num_epochs": 4}}, [option])

    def test_non_mapping_section_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "must be a mapping"):
            apply_overrides({"train": {"num_epochs": 4}, "model": "invalid"}, ["model.target=example"])

    def test_flat_config_overrides_still_work(self):
        cfg = {"num_epochs": 4, "batch_size": 8}
        apply_overrides(cfg, ["num_epochs=9", "batch_size=2"])
        self.assertEqual(flatten_config(cfg), {"num_epochs": 9, "batch_size": 2})

    def test_legacy_cli_flags_still_map_to_structured_keys(self):
        from scripts.train import load_config as load_train_config, parse_args

        argv = ["train.py", "--config", str(ROOT / "configs/_base_/default.yaml"), "--num_epochs", "9", "--batch_size", "2"]
        with patch.object(sys, "argv", argv):
            cfg = load_train_config(parse_args())
        self.assertEqual(cfg["num_epochs"], 9)
        self.assertEqual(cfg["batch_size"], 2)

    def test_minimax_role_options_fail_in_flat_and_structured_configs(self):
        for key in ("optimizer_minimax_base_url", "target_minimax_base_url", "optimizer_minimax_api_key", "target_minimax_api_key"):
            for cfg in ({key: "synthetic"}, {"model": {key: "synthetic"}}, {"env": {key: "synthetic"}}):
                with self.subTest(key=key, cfg=cfg), self.assertRaisesRegex(ValueError, "Unsupported MiniMax role option"):
                    flatten_config(cfg)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "Unsupported MiniMax role option"):
                apply_overrides({"model": {}}, [f"model.{key}=synthetic"])

    def test_minimax_optimizer_is_rejected_before_dispatch(self):
        for backend in ("minimax", "minimax_chat"):
            for cfg in ({"optimizer_backend": backend}, {"model": {"optimizer_backend": backend}}):
                with self.subTest(cfg=cfg), self.assertRaisesRegex(ValueError, "MiniMax optimizer is not implemented"):
                    flatten_config(cfg)
            with patch.object(backend_config, "OPTIMIZER_BACKEND", "openai_chat"), patch.dict(os.environ):
                with self.assertRaisesRegex(ValueError, "MiniMax is supported only as a target"):
                    backend_config.set_optimizer_backend(backend)
                self.assertEqual(backend_config.get_optimizer_backend(), "openai_chat")

    def test_minimax_target_shared_config_is_supported(self):
        cfg = flatten_config({"model": {"target_backend": "minimax_chat", "minimax_model": "synthetic-model", "minimax_base_url": "https://example.invalid/v1"}})
        self.assertEqual(cfg["target_backend"], "minimax_chat")
        self.assertEqual(cfg["minimax_model"], "synthetic-model")
        with patch.object(backend_config, "TARGET_BACKEND", "openai_chat"), patch.dict(os.environ):
            backend_config.set_target_backend("minimax")
            self.assertEqual(backend_config.get_target_backend(), "minimax_chat")

    def test_invalid_merge_size_is_rejected_in_config(self):
        for size in (0, 1, -1, True, 2.5, "2"):
            with self.subTest(size=size), self.assertRaisesRegex(ValueError, "merge_batch_size"):
                flatten_config({"gradient": {"merge_batch_size": size}})
        self.assertEqual(flatten_config({"gradient": {"merge_batch_size": 2}})["merge_batch_size"], 2)


if __name__ == "__main__":
    unittest.main()
