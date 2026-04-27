"""Tests for artifact export rubric contract metadata."""

import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from optimize_stages import export_stage_artifact


@pytest.fixture
def dummy_data_file():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        f.write('{"id": "test"}\n')
        return f.name


def _make_mock_module(instruction: str = "test instruction"):
    module = MagicMock()
    module.predict.signature.instructions = instruction
    module.predict.demos = []
    return module


class TestExportStageArtifact:
    def test_planner_has_rubric_metadata(self, dummy_data_file):
        artifact = export_stage_artifact(
            stage="planner",
            optimized_module=_make_mock_module(),
            val_score=0.9,
            baseline_score=0.8,
            teacher_model="test-model",
            data_path=dummy_data_file,
            training_count=100,
            val_count=25,
        )
        meta = artifact["metadata"]
        assert meta["rubric_contract"] == "eval-judge-stage-rubric-v1.0"
        assert meta["label_source"] == "metadata.stageScores.plan.score"
        assert meta["required_scalar_output"] == "plan_score"
        assert meta["compatible_output_contract"] == "scalar-alias-plus-stageScores"

    def test_coder_has_rubric_metadata(self, dummy_data_file):
        artifact = export_stage_artifact(
            stage="coder",
            optimized_module=_make_mock_module(),
            val_score=0.85,
            baseline_score=0.8,
            teacher_model="test-model",
            data_path=dummy_data_file,
            training_count=50,
            val_count=15,
        )
        meta = artifact["metadata"]
        assert meta["rubric_contract"] == "eval-judge-stage-rubric-v1.0"
        assert meta["label_source"] == "metadata.stageScores.implementation.score"
        assert meta["required_scalar_output"] == "implementation_score"

    def test_reviewer_has_rubric_metadata(self, dummy_data_file):
        artifact = export_stage_artifact(
            stage="reviewer",
            optimized_module=_make_mock_module(),
            val_score=0.88,
            baseline_score=0.82,
            teacher_model="test-model",
            data_path=dummy_data_file,
            training_count=80,
            val_count=20,
        )
        meta = artifact["metadata"]
        assert meta["label_source"] == "metadata.stageScores.review.score"
        assert meta["required_scalar_output"] == "review_score"

    def test_existing_metadata_preserved(self, dummy_data_file):
        artifact = export_stage_artifact(
            stage="planner",
            optimized_module=_make_mock_module(),
            val_score=0.9,
            baseline_score=0.8,
            teacher_model="test-model",
            data_path=dummy_data_file,
            training_count=100,
            val_count=25,
        )
        meta = artifact["metadata"]
        assert meta["training_records"] == 100
        assert meta["validation_records"] == 25
        assert meta["baseline_score"] == 0.8
        assert meta["optimized_score"] == 0.9
        assert "data_hash" in meta
        assert meta["data_hash"].startswith("sha256:")
