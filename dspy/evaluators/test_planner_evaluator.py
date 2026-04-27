from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from planner_evaluator import parse_planner_output


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
