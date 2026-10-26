import json
import unittest
from unittest.mock import patch

from skillopt.gradient import aggregate


class AggregateTests(unittest.TestCase):
    def test_invalid_batch_size_fails_before_prompts_or_model(self):
        for size in (-1, 0, 1, True, 2.5):
            with self.subTest(size=size), patch.object(aggregate, "chat_optimizer") as model, patch.object(aggregate, "load_prompt") as prompt:
                with self.assertRaisesRegex(ValueError, "merge_batch_size"):
                    aggregate.merge_patches("skill", [], [], batch_size=size)
                model.assert_not_called()
                prompt.assert_not_called()

    def test_internal_merge_also_rejects_nonconverging_batch_size(self):
        with self.assertRaisesRegex(ValueError, "merge_batch_size"):
            aggregate._hierarchical_merge("skill", [{"edits": []}, {"edits": []}], "prompt", "patch", 1, False)

    def test_valid_batches_converge(self):
        patch_data = {"edits": [{"op": "append", "content": "synthetic rule"}]}
        with patch.object(aggregate, "chat_optimizer", return_value=(json.dumps(patch_data), {})) as model:
            result = aggregate._hierarchical_merge("skill", [patch_data.copy() for _ in range(5)], "prompt", "patch", 2, False)
        self.assertEqual(model.call_count, 4)
        self.assertEqual(result["edits"][0]["content"], "synthetic rule")

    def test_empty_groups_are_still_a_noop(self):
        with patch.object(aggregate, "chat_optimizer") as model:
            result = aggregate.merge_patches("skill", [], [], batch_size=2, verbose=False)
        self.assertEqual(result["edits"], [])
        model.assert_not_called()

    def test_single_patch_is_preserved_without_model_call(self):
        patch_data = {"edits": [{"op": "append", "content": "synthetic rule"}]}
        with patch.object(aggregate, "chat_optimizer") as model:
            result = aggregate.merge_patches("skill", [patch_data], [], batch_size=2, verbose=False)
        self.assertEqual(result, patch_data)
        model.assert_not_called()


if __name__ == "__main__":
    unittest.main()
