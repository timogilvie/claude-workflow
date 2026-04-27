from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from planner_evaluator import PlannerEvaluatorSignature, parse_planner_output


PLANNER_RUBRIC_OUTPUT_FIELDS = frozenset(
    {
        "plan_score",
        "quality_band",
        "reasoning",
        "component_boundaries",
        "invariant_coverage",
        "sequencing_and_dependencies",
        "risk_and_validation_coverage",
    }
)


def test_signature_output_fields_match_production_rubric():
    assert PlannerEvaluatorSignature is not None, "DSPy not installed"

    actual = frozenset(PlannerEvaluatorSignature.output_fields.keys())
    extra = actual - PLANNER_RUBRIC_OUTPUT_FIELDS
    missing = PLANNER_RUBRIC_OUTPUT_FIELDS - actual

    assert not extra and not missing, f"Signature mismatch: extra={extra}, missing={missing}"


def test_parse_planner_legacy_minimal_json():
    result = parse_planner_output(
        json.dumps(
            {
                "plan_score": 0.82,
                "quality_band": "good",
                "reasoning": "The plan covered the main files and validation.",
            }
        )
    )

    assert result["plan_score"] == 0.82
    assert result["quality_band"] == "good"
    assert result["reasoning"] == "The plan covered the main files and validation."


def test_parse_planner_missing_rubric_criterion_handled():
    result = parse_planner_output(
        json.dumps({"plan_score": 0.75, "quality_band": "good", "reasoning": "OK plan."})
    )

    assert result["plan_score"] == 0.75
    for field in [
        "component_boundaries",
        "invariant_coverage",
        "sequencing_and_dependencies",
        "risk_and_validation_coverage",
    ]:
        assert field not in result or isinstance(result.get(field), (int, float, type(None)))


def test_parse_planner_rubric_criterion_out_of_domain():
    result = parse_planner_output(
        json.dumps(
            {
                "plan_score": 0.8,
                "quality_band": "good",
                "reasoning": "Strong plan.",
                "component_boundaries": 1.5,
            }
        )
    )

    assert result["plan_score"] == 0.8
    assert result["component_boundaries"] == 1.5


def test_parse_planner_derives_from_stage_scores_and_preserves_rubric():
    result = parse_planner_output(
        """
        ```json
        {
          "stageScores": {
            "plan": {
              "score": "0.64",
              "rationale": "The plan identified scope but missed validation risks."
            }
          },
          "rubricEval": {
            "completeness": {"score": 0.7, "rationale": "Mostly scoped."},
            "correctness": {"score": 0.6, "rationale": "Some sequencing gaps."},
            "code_quality": {"score": 0.6, "rationale": "Reasonable maintainability signal."},
            "intervention_impact": {"score": 0.5, "rationale": "Interventions indicate plan misses."},
            "autonomy": {"score": 0.7, "rationale": "Mostly autonomous."}
          }
        }
        ```
        """
    )

    assert result["plan_score"] == 0.64
    assert result["quality_band"] == "weak"
    assert result["reasoning"] == "The plan identified scope but missed validation risks."
    assert result["rubricEval"]["completeness"]["score"] == 0.7


def test_parse_planner_preserves_unknown_extra_fields():
    result = parse_planner_output(
        json.dumps(
            {
                "plan_score": 0.91,
                "quality_band": "excellent",
                "reasoning": "Strong planning.",
                "extraAudit": {"kept": True},
            }
        )
    )

    assert result["plan_score"] == 0.91
    assert result["extraAudit"] == {"kept": True}


def test_parse_planner_malformed_json_returns_sentinel():
    result = parse_planner_output("{not valid json")

    assert result["plan_score"] == -1
    assert result["quality_band"] == "unknown"
    assert result["reasoning"] == "Parse failed"


def test_parse_planner_invalid_runner_score_returns_sentinel():
    result = parse_planner_output(
        json.dumps(
            {
                "plan_score": "high",
                "stageScores": {"plan": {"score": 0.8, "rationale": "Fallback should not mask invalid runner field."}},
            }
        )
    )

    assert result["plan_score"] == -1
    assert result["quality_band"] == "unknown"
