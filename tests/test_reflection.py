import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from skillopt.gradient import reflect


class ReflectionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.predictions = self.root / "predictions"
        self.results = [{"id": "failure", "hard": 0}, {"id": "success", "hard": 1}]
        for result in self.results:
            directory = self.predictions / result["id"]
            directory.mkdir(parents=True)
            (directory / "conversation.json").write_text(json.dumps([{"role": "assistant", "content": "synthetic answer"}]))

    def analysts(self):
        return (reflect.run_error_analyst_minibatch, reflect.run_success_analyst_minibatch)

    def call(self, analyst, **kwargs):
        return analyst("synthetic skill", [self.results[0]], str(self.predictions), system_prompt="synthetic prompt", **kwargs)

    def dispatch(self, **kwargs):
        return reflect.run_minibatch_reflect(
            self.results, "synthetic skill", str(self.predictions), str(self.root / "patches"),
            workers=2, failure_only=False, minibatch_size=1,
            error_system="failure prompt", success_system="success prompt",
            skill_aware_reflection=False, **kwargs,
        )

    def test_model_failure_is_not_a_noop(self):
        for analyst in self.analysts():
            cause = TimeoutError("synthetic timeout")
            with self.subTest(analyst=analyst.__name__), patch.object(reflect, "chat_optimizer", side_effect=cause):
                with self.assertRaises(reflect.ReflectionError) as caught:
                    self.call(analyst)
                self.assertIs(caught.exception.__cause__, cause)

    def test_invalid_json_or_patch_is_rejected(self):
        responses = ["not JSON", "{}", '{"patch": null}', '{"patch": {}}', '{"patch": {"edits": "invalid"}}', '{"patch": {"edits": [1]}}']
        for analyst in self.analysts():
            for response in responses:
                with self.subTest(analyst=analyst.__name__, response=response), patch.object(reflect, "chat_optimizer", return_value=(response, {})):
                    with self.assertRaises(reflect.ReflectionError):
                        self.call(analyst)

    def test_empty_patches_are_valid_in_each_mode(self):
        for mode, key in (("patch", "edits"), ("rewrite_from_suggestions", "revise_suggestions"), ("full_rewrite_minibatch", "skill_candidates")):
            for analyst in self.analysts():
                response = json.dumps({"patch": {key: []}})
                with self.subTest(mode=mode, analyst=analyst.__name__), patch.object(reflect, "chat_optimizer", return_value=(response, {})):
                    result = self.call(analyst, update_mode=mode)
                self.assertIsInstance(result, dict)
                self.assertEqual(result["patch"][key], [])

    def test_successful_edits_keep_budget(self):
        response = json.dumps({"patch": {"edits": [{"op": "append", "content": str(i)} for i in range(4)]}})
        for analyst in self.analysts():
            with self.subTest(analyst=analyst.__name__), patch.object(reflect, "chat_optimizer", return_value=(response, {})):
                result = self.call(analyst, edit_budget=2)
            self.assertEqual(len(result["patch"]["edits"]), 2)

    def test_full_rewrite_is_not_truncated_by_edit_budget(self):
        candidates = [{"new_skill": "first"}, {"new_skill": "second"}]
        response = json.dumps({"patch": {"skill_candidates": candidates}})
        for analyst in self.analysts():
            with self.subTest(analyst=analyst.__name__), patch.object(reflect, "chat_optimizer", return_value=(response, {})):
                result = self.call(analyst, edit_budget=1, update_mode="full_rewrite_minibatch")
            self.assertEqual(result["patch"]["skill_candidates"], candidates)

    def test_appendix_only_response_is_valid(self):
        response = json.dumps({"appendix_notes": ["follow the existing evidence rule"]})
        for analyst in self.analysts():
            with self.subTest(analyst=analyst.__name__), patch.object(reflect, "chat_optimizer", return_value=(response, {})):
                result = self.call(analyst, skill_aware_reflection=True)
            self.assertEqual(result["patch"]["edits"], [])
            self.assertEqual(result["appendix_notes"], ["follow the existing evidence rule"])

    def test_no_trajectory_does_not_call_model(self):
        for analyst in self.analysts():
            with self.subTest(analyst=analyst.__name__), patch.object(reflect, "chat_optimizer") as model:
                result = analyst("skill", [{"id": "missing"}], str(self.predictions), system_prompt="prompt")
            self.assertIsNone(result)
            model.assert_not_called()

    def test_parallel_dispatch_propagates_api_and_parse_failures(self):
        for response in (None, "not JSON"):
            kwargs = {"side_effect": TimeoutError("synthetic timeout")} if response is None else {"return_value": (response, {})}
            with self.subTest(response=response), patch.object(reflect, "chat_optimizer", **kwargs):
                with self.assertRaises(reflect.ReflectionError):
                    self.dispatch()
            self.assertFalse(list((self.root / "patches").glob("*.json")))

    def test_parallel_dispatch_does_not_hide_one_failed_minibatch(self):
        def model(**kwargs):
            if kwargs["system"] == "failure prompt":
                raise TimeoutError("synthetic timeout")
            return json.dumps({"patch": {"edits": []}}), {}

        with patch.object(reflect, "chat_optimizer", side_effect=model):
            with self.assertRaises(reflect.ReflectionError):
                self.dispatch()
        self.assertFalse((self.root / "patches/minibatch_fail_000.json").exists())

    def test_parallel_dispatch_preserves_appendix_only_results(self):
        response = json.dumps({"appendix_notes": ["follow the existing evidence rule"]})
        with patch.object(reflect, "chat_optimizer", return_value=(response, {})):
            result = reflect.run_minibatch_reflect(
                self.results, "synthetic skill", str(self.predictions), str(self.root / "patches"),
                workers=2, failure_only=False, minibatch_size=1,
                error_system="failure prompt", success_system="success prompt",
                skill_aware_reflection=True, skill_aware_appendix_source="both",
            )
        self.assertEqual({item["source_type"] for item in result}, {"failure", "success"})
        for item in result:
            self.assertEqual(item["patch"]["edits"], [])
            self.assertEqual(item["appendix_notes"], ["follow the existing evidence rule"])

    def test_parallel_dispatch_preserves_and_resumes_empty_patches(self):
        response = json.dumps({"patch": {"edits": []}})
        with patch.object(reflect, "chat_optimizer", return_value=(response, {})) as model:
            result = self.dispatch()
        self.assertEqual(len(result), 2)
        self.assertEqual(model.call_count, 2)
        with patch.object(reflect, "chat_optimizer") as model:
            resumed = self.dispatch()
        model.assert_not_called()
        self.assertEqual(len(resumed), 2)


if __name__ == "__main__":
    unittest.main()
