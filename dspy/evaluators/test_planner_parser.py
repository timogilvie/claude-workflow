"""Tests for planner evaluator parser normalization."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from planner_evaluator import parse_planner_output, score_to_plan_band


class TestParsePlannerOutput:
    """Test planner parser accepts old, rich, and fallback formats."""

    def test_old_minimal_json(self):
        raw = json.dumps({"plan_score": 0.82, "quality_band": "good", "reasoning": "Solid plan."})
        result = parse_planner_output(raw)
        assert result["plan_score"] == 0.82
        assert result["quality_band"] == "good"
        assert result["reasoning"] == "Solid plan."

    def test_richer_json_with_stage_scores(self):
        raw = json.dumps({
            "plan_score": 0.75,
            "quality_band": "good",
            "reasoning": "Good scope.",
            "stageScores": {
                "plan": {
                    "score": 0.75,
                    "rationale": "Good scope identification.",
                    "rubricCriteria": [
                        {"criterion": "component_boundaries", "score": 0.8, "notes": "OK"},
                        {"criterion": "invariant_coverage", "score": 0.7, "notes": "Minor gap"},
                    ],
                }
            },
        })
        result = parse_planner_output(raw)
        assert result["plan_score"] == 0.75
        assert result["quality_band"] == "good"
        assert "stageScores" in result
        assert len(result["stageScores"]["plan"]["rubricCriteria"]) == 2

    def test_derives_scalar_from_stage_scores_only(self):
        raw = json.dumps({
            "reasoning": "Derived from nested.",
            "stageScores": {"plan": {"score": 0.65, "rationale": "Weak plan."}},
        })
        result = parse_planner_output(raw)
        assert result["plan_score"] == 0.65
        assert result["quality_band"] == "weak"

    def test_derives_band_when_score_present_but_band_missing(self):
        raw = json.dumps({"plan_score": 0.95, "reasoning": "Excellent."})
        result = parse_planner_output(raw)
        assert result["quality_band"] == "excellent"

    def test_markdown_fences_stripped(self):
        raw = '```json\n{"plan_score": 0.5, "quality_band": "weak", "reasoning": "Fenced."}\n```'
        result = parse_planner_output(raw)
        assert result["plan_score"] == 0.5

    def test_preamble_text_before_json(self):
        raw = 'Here is my evaluation:\n{"plan_score": 0.3, "quality_band": "poor", "reasoning": "Bad."}'
        result = parse_planner_output(raw)
        assert result["plan_score"] == 0.3

    def test_malformed_output_fallback(self):
        result = parse_planner_output("This is not JSON at all.")
        assert result["plan_score"] == -1
        assert result["quality_band"] == "unknown"
        assert "Parse failed" in result["reasoning"]

    def test_extra_keys_preserved(self):
        raw = json.dumps({
            "plan_score": 0.8,
            "quality_band": "good",
            "reasoning": "Good.",
            "rubricEval": {"schema_version": "1.0"},
            "planCritique": {"overall": {"score": 0.8}},
        })
        result = parse_planner_output(raw)
        assert result["plan_score"] == 0.8
        assert "rubricEval" in result
        assert "planCritique" in result

    def test_empty_string_fallback(self):
        result = parse_planner_output("")
        assert result["plan_score"] == -1


class TestScoreToPlanBand:
    def test_boundaries(self):
        assert score_to_plan_band(0.0) == "poor"
        assert score_to_plan_band(0.39) == "poor"
        assert score_to_plan_band(0.4) == "weak"
        assert score_to_plan_band(0.7) == "good"
        assert score_to_plan_band(0.9) == "excellent"
        assert score_to_plan_band(1.0) == "excellent"
