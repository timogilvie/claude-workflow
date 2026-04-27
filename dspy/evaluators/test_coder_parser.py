"""Tests for coder evaluator parser normalization."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from coder_evaluator import parse_coder_output, score_to_impl_band


class TestParseCoderOutput:
    """Test coder parser accepts old, rich, and fallback formats."""

    def test_old_minimal_json(self):
        raw = json.dumps({"implementation_score": 0.85, "quality_band": "good", "reasoning": "Correct."})
        result = parse_coder_output(raw)
        assert result["implementation_score"] == 0.85
        assert result["quality_band"] == "good"
        assert result["reasoning"] == "Correct."

    def test_richer_json_with_stage_scores(self):
        raw = json.dumps({
            "implementation_score": 0.9,
            "quality_band": "excellent",
            "reasoning": "Clean implementation.",
            "stageScores": {
                "implementation": {
                    "score": 0.9,
                    "rationale": "All requirements met.",
                    "rubricCriteria": [
                        {"criterion": "requirement_completeness", "score": 0.95, "notes": "Full coverage."},
                        {"criterion": "correctness", "score": 0.9, "notes": "No bugs."},
                        {"criterion": "integration_with_existing_patterns", "score": 0.85, "notes": "Good fit."},
                        {"criterion": "code_quality_and_test_coverage", "score": 0.9, "notes": "Clean."},
                    ],
                }
            },
        })
        result = parse_coder_output(raw)
        assert result["implementation_score"] == 0.9
        assert "stageScores" in result
        assert len(result["stageScores"]["implementation"]["rubricCriteria"]) == 4

    def test_derives_scalar_from_stage_scores_only(self):
        raw = json.dumps({
            "reasoning": "Nested only.",
            "stageScores": {"implementation": {"score": 0.55, "rationale": "Acceptable."}},
        })
        result = parse_coder_output(raw)
        assert result["implementation_score"] == 0.55
        assert result["quality_band"] == "acceptable"

    def test_derives_band_when_score_present_but_band_missing(self):
        raw = json.dumps({"implementation_score": 0.95, "reasoning": "Excellent."})
        result = parse_coder_output(raw)
        assert result["quality_band"] == "excellent"

    def test_markdown_fences_stripped(self):
        raw = '```json\n{"implementation_score": 0.6, "quality_band": "acceptable", "reasoning": "OK."}\n```'
        result = parse_coder_output(raw)
        assert result["implementation_score"] == 0.6

    def test_preamble_text_before_json(self):
        raw = 'My evaluation:\n{"implementation_score": 0.3, "quality_band": "poor", "reasoning": "Bad."}'
        result = parse_coder_output(raw)
        assert result["implementation_score"] == 0.3

    def test_malformed_output_fallback(self):
        result = parse_coder_output("Not valid JSON.")
        assert result["implementation_score"] == -1
        assert result["quality_band"] == "unknown"
        assert "Parse failed" in result["reasoning"]

    def test_extra_keys_preserved(self):
        raw = json.dumps({
            "implementation_score": 0.8,
            "quality_band": "good",
            "reasoning": "Good.",
            "rubricEval": {"schema_version": "1.0"},
        })
        result = parse_coder_output(raw)
        assert result["implementation_score"] == 0.8
        assert "rubricEval" in result

    def test_empty_string_fallback(self):
        result = parse_coder_output("")
        assert result["implementation_score"] == -1


class TestScoreToImplBand:
    def test_boundaries(self):
        assert score_to_impl_band(0.0) == "poor"
        assert score_to_impl_band(0.49) == "poor"
        assert score_to_impl_band(0.5) == "acceptable"
        assert score_to_impl_band(0.7) == "good"
        assert score_to_impl_band(0.9) == "excellent"
        assert score_to_impl_band(1.0) == "excellent"
