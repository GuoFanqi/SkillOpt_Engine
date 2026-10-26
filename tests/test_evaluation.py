import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from skillopt.envs.officeqa.evaluator import evaluate as evaluate_office
from skillopt.envs.searchqa.evaluator import evaluate as evaluate_search
from skillopt.envs.searchqa.rollout import process_one
from skillopt.utils.scoring import IncompleteEvaluationError, compute_score, evaluation_coverage


class EvaluationTests(unittest.TestCase):
    def test_office_quantities_preserve_magnitude(self):
        for prediction, gold in [
            ("1 million dollars", "1 billion dollars"),
            ("1 dollar", "1 billion dollars"),
            ("-1 million", "1 million"),
        ]:
            with self.subTest(prediction=prediction, gold=gold):
                self.assertEqual(evaluate_office(prediction, gold)["em"], 0)

    def test_office_equivalent_amounts(self):
        for prediction, gold in [
            ("1 million dollars", "1,000,000 dollars"),
            ("1.5 billion dollars", "1500000000.0"),
            ("-2 million", "-2000000"),
            ("25.0%", "25%"),
        ]:
            with self.subTest(prediction=prediction, gold=gold):
                self.assertEqual(evaluate_office(prediction, gold)["em"], 1)

    def test_searchqa_default_metrics_unchanged(self):
        result = evaluate_search("Reasoning\n<answer>The White House</answer>", ["white house"])
        self.assertEqual(result["em"], 1)
        self.assertEqual(result["f1"], 1)
        self.assertNotIn("constraint_passed", result)
        self.assertEqual(evaluate_search("<answer>red blue</answer>", ["red green"])["f1"], 0.5)

    def test_full_response_constraints_do_not_replace_answer_metrics(self):
        result = evaluate_search("无法确认是否到账。\n<answer>已发奖</answer>", ["已发奖"], ["到账", "入账"])
        self.assertEqual((result["em"], result["f1"]), (1, 1))
        self.assertEqual((result["hard"], result["soft"]), (0, 0))
        self.assertFalse(result["constraint_passed"])
        self.assertEqual(result["constraint_violations"], ["到账"])
        clean = evaluate_search("<answer>已发奖</answer>", ["已发奖"], ["到账"])
        self.assertTrue(clean["constraint_passed"])
        self.assertEqual(clean["hard"], 1)

    def test_constraint_schema(self):
        for invalid in ("到账", [""], [3], {}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                evaluate_search("text", ["text"], invalid)

    def test_rollout_uses_full_response_constraint(self):
        item = {"id": "case", "question": "是否发奖", "answers": ["已发奖"], "forbidden_terms": ["到账"]}
        with tempfile.TemporaryDirectory() as directory, \
                patch("skillopt.envs.searchqa.rollout.is_target_exec_backend", return_value=False), \
                patch("skillopt.envs.searchqa.rollout.chat_target", return_value=("无法确认是否到账。<answer>已发奖</answer>", None)) as model:
            result = process_one(item, directory, "Only report award status")
        model.assert_called_once()
        self.assertTrue(result["agent_ok"])
        self.assertEqual((result["hard"], result["soft"]), (0, 0))
        self.assertEqual((result["em"], result["f1"]), (1, 1))
        self.assertIn("constraint-violation", result["fail_reason"])
        self.assertEqual(compute_score([result]), (0, 0))

    def test_exec_rollout_enforces_same_constraints(self):
        item = {"id": "case", "question": "是否发奖", "answers": ["已发奖"], "forbidden_terms": ["到账"]}
        with tempfile.TemporaryDirectory() as directory, \
                patch("skillopt.envs.searchqa.rollout.is_target_exec_backend", return_value=True), \
                patch("skillopt.envs.searchqa.rollout._run_codex_once", return_value=("无法确认是否到账。<answer>已发奖</answer>", "", "system", "question")):
            result = process_one(item, directory, "skill")
        self.assertEqual(result["em"], 1)
        self.assertEqual(result["hard"], 0)
        self.assertEqual(result["constraint_violations"], ["到账"])

    def test_invalid_constraints_fail_before_model_call(self):
        item = {"id": "case", "question": "q", "forbidden_terms": "到账"}
        with tempfile.TemporaryDirectory() as directory, \
                patch("skillopt.envs.searchqa.rollout.chat_target") as model:
            with self.assertRaises(ValueError):
                process_one(item, directory, "skill")
        model.assert_not_called()

    def test_partial_execution_failure_has_no_score(self):
        rows = [{"hard": 1, "soft": 1, "agent_ok": True}, {"hard": 0, "soft": 0, "agent_ok": False}]
        with self.assertRaises(IncompleteEvaluationError) as caught:
            compute_score(rows)
        self.assertEqual(caught.exception.coverage, {"total": 2, "valid": 1, "execution_errors": 1, "coverage": 0.5})
        self.assertEqual(evaluation_coverage(rows)["total"], 2)

    def test_wrong_answers_and_invalid_generated_code_are_still_scored(self):
        rows = [{"hard": 1, "soft": 1, "agent_ok": True}, {"hard": 0, "soft": 0, "llm_ok": True, "exec_ok": False}]
        self.assertEqual(compute_score(rows), (0.5, 0.5))
        self.assertEqual(compute_score([{"hard": 0, "soft": 0, "agent_ok": True}]), (0, 0))

    def test_empty_and_wrapped_execution_errors_are_rejected(self):
        for rows in ([], [SimpleNamespace(hard=0, soft=0, extras={"execution_error": True})]):
            with self.subTest(rows=rows), self.assertRaises(IncompleteEvaluationError):
                compute_score(rows)


if __name__ == "__main__":
    unittest.main()
