from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from coder_evaluator import CoderEvaluatorSignature, parse_coder_output


CODER_RUBRIC_OUTPUT_FIELDS = frozenset(
    {
        "implementation_score",
        "quality_band",
        "reasoning",
        "requirement_completeness",
        "correctness",
        "integration_with_existing_patterns",
        "code_quality_and_test_coverage",
    }
)


def test_signature_output_fields_match_production_rubric():
    assert CoderEvaluatorSignature is not None, "DSPy not installed"

    actual = frozenset(CoderEvaluatorSignature.output_fields.keys())
    extra = actual - CODER_RUBRIC_OUTPUT_FIELDS
    missing = CODER_RUBRIC_OUTPUT_FIELDS - actual

    assert not extra and not missing, f"Signature mismatch: extra={extra}, missing={missing}"


def test_parse_coder_legacy_minimal_json():
    result = parse_coder_output(
        json.dumps(
            {
                "implementation_score": 0.78,
                "quality_band": "good",
                "reasoning": "The implementation was mostly complete.",
            }
        )
    )

    assert result["implementation_score"] == 0.78
    assert result["quality_band"] == "good"
    assert result["reasoning"] == "The implementation was mostly complete."


def test_parse_coder_missing_rubric_criterion_handled():
    result = parse_coder_output(
        json.dumps({"implementation_score": 0.75, "quality_band": "good", "reasoning": "OK implementation."})
    )

    assert result["implementation_score"] == 0.75
    for field in [
        "requirement_completeness",
        "correctness",
        "integration_with_existing_patterns",
        "code_quality_and_test_coverage",
    ]:
        assert field not in result or isinstance(result.get(field), (int, float, type(None)))


def test_parse_coder_rubric_criterion_out_of_domain():
    result = parse_coder_output(
        json.dumps(
            {
                "implementation_score": 0.8,
                "quality_band": "good",
                "reasoning": "Solid implementation.",
                "correctness": 1.5,
            }
        )
    )

    assert result["implementation_score"] == 0.8
    assert result["correctness"] == 1.5


def test_parse_coder_derives_from_stage_scores_and_preserves_rubric():
    result = parse_coder_output(
        """
        Here is the evaluation:
        {
          "stageScores": {
            "implementation": {
              "score": "0.58",
              "rationale": "The code landed but missed important edge cases."
            }
          },
          "rubricEval": {
            "completeness": {"score": 0.6, "rationale": "Some requirements missed."},
            "correctness": {"score": 0.55, "rationale": "Edge-case gaps."},
            "code_quality": {"score": 0.65, "rationale": "Readable but thin tests."},
            "intervention_impact": {"score": 0.45, "rationale": "Interventions were needed."},
            "autonomy": {"score": 0.6, "rationale": "Moderate autonomy."}
          }
        }
        trailing text
        """
    )

    assert result["implementation_score"] == 0.58
    assert result["quality_band"] == "acceptable"
    assert result["reasoning"] == "The code landed but missed important edge cases."
    assert result["rubricEval"]["correctness"]["score"] == 0.55


def test_parse_coder_preserves_unknown_extra_fields():
    result = parse_coder_output(
        json.dumps(
            {
                "implementation_score": 0.43,
                "quality_band": "poor",
                "reasoning": "Major issues remain.",
                "extraAudit": ["kept"],
            }
        )
    )

    assert result["implementation_score"] == 0.43
    assert result["extraAudit"] == ["kept"]


def test_parse_coder_malformed_json_returns_sentinel():
    result = parse_coder_output("{not valid json")

    assert result["implementation_score"] == -1
    assert result["quality_band"] == "unknown"
    assert result["reasoning"] == "Parse failed"


def test_parse_coder_invalid_runner_score_returns_sentinel():
    result = parse_coder_output(
        json.dumps(
            {
                "implementation_score": "complete",
                "stageScores": {
                    "implementation": {
                        "score": 0.8,
                        "rationale": "Fallback should not mask invalid runner field.",
                    }
                },
            }
        )
    )

    assert result["implementation_score"] == -1
    assert result["quality_band"] == "unknown"
