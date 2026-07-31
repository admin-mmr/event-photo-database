"""Tests for the model registry: the version must describe what actually loaded,
and a missing person detector must not pass silently.

Regression cover for a real incident: `MODEL_VERSION` was a constant claiming
`+yolov8n+`, `yolov8n.onnx` was never staged, and every event (9 events / 9,574
photos / 55,270 person crops) was embedded with face-box expansion under a tag
that said otherwise. Nothing in the system could tell the two apart.
"""

from __future__ import annotations

import importlib
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _fresh(monkeypatch, **env):
    """Re-import registry with a given environment (module-level env reads)."""
    for key in ("MODEL_VERSION", "REQUIRE_PERSON_DET", "MODEL_DIR"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    import models.registry as registry

    return importlib.reload(registry)


class FakeModel:
    dim = 512

    def embed(self, *a, **k):
        return None

    def detect(self, *a, **k):
        return []


def _bundle(registry, person_det):
    return registry.ModelBundle(
        face_det=FakeModel(),
        face_emb=FakeModel(),
        person_emb=FakeModel(),
        person_det=person_det,
    )


# ── the version tells the truth ──────────────────────────────────────────────


def test_version_differs_by_person_crop_geometry(monkeypatch):
    registry = _fresh(monkeypatch)
    with_det = registry.model_version(True)
    without = registry.model_version(False)
    assert with_det != without, "the two geometries must not share a tag"
    assert registry.PERSON_DET_TOKEN in with_det
    assert registry.FACE_EXPAND_TOKEN in without
    # The fallback must NOT claim the detector — the whole bug.
    assert registry.PERSON_DET_TOKEN not in without


def test_bundle_version_is_derived_from_the_loaded_models(monkeypatch):
    registry = _fresh(monkeypatch)
    assert registry.FACE_EXPAND_TOKEN in _bundle(registry, None).version
    assert registry.PERSON_DET_TOKEN in _bundle(registry, FakeModel()).version


def test_uses_person_detector_reports_geometry(monkeypatch):
    registry = _fresh(monkeypatch)
    assert _bundle(registry, None).uses_person_detector is False
    assert _bundle(registry, FakeModel()).uses_person_detector is True


def test_explicit_override_wins(monkeypatch):
    """An override is how a replay pins a historical version, so it must beat the
    derived value for both geometries."""
    registry = _fresh(monkeypatch, MODEL_VERSION="pinned@x9")
    assert registry.model_version(True) == "pinned@x9"
    assert registry.model_version(False) == "pinned@x9"
    assert _bundle(registry, None).version == "pinned@x9"


def test_version_shape_is_unchanged_when_the_detector_is_present(monkeypatch):
    """Guards the reuse check: with the detector staged, the tag must be exactly
    the historical `@m1` string, so staging the file does not gratuitously
    invalidate rows a second time."""
    registry = _fresh(monkeypatch)
    assert registry.model_version(True) == "scrfd10g+yolov8n+arcface_r50+osnet_x0_25@m1"


# ── a missing detector is not silent ────────────────────────────────────────


def test_require_person_det_raises_when_absent(monkeypatch, tmp_path):
    """The indexer's posture: rather than write face-expanded crops, fail."""
    registry = _fresh(monkeypatch, MODEL_DIR=str(tmp_path))
    for name in ("det_10g.onnx", "w600k_r50.onnx", "osnet_x0_25.onnx"):
        (tmp_path / name).write_bytes(b"stub")
    with pytest.raises(FileNotFoundError, match="Person detector missing"):
        registry.load_bundle(require_person_det=True)


def test_missing_required_model_still_raises_first(monkeypatch, tmp_path):
    registry = _fresh(monkeypatch, MODEL_DIR=str(tmp_path))
    with pytest.raises(FileNotFoundError, match="Required model file missing"):
        registry.load_bundle(require_person_det=False)


def test_tolerant_load_logs_an_error_not_a_warning(monkeypatch, tmp_path, caplog):
    """The service's posture: keep serving, but say so loudly. ERROR because a
    warning is what got ignored for months."""
    registry = _fresh(monkeypatch, MODEL_DIR=str(tmp_path))
    for name in ("det_10g.onnx", "w600k_r50.onnx", "osnet_x0_25.onnx"):
        (tmp_path / name).write_bytes(b"stub")

    # The stub files are not real ONNX, so replace the wrapper classes that would
    # try to parse them. The real ModelBundle is kept — its version derivation is
    # part of what this test covers.
    class _Stub:
        def __init__(self, *a, **k):
            pass

    import models.arcface as arcface
    import models.person as person
    import models.scrfd as scrfd

    monkeypatch.setattr(scrfd, "ScrfdDetector", _Stub)
    monkeypatch.setattr(arcface, "ArcFaceEmbedder", _Stub)
    monkeypatch.setattr(person, "ReidEmbedder", _Stub)
    registry.set_bundle(None)

    with caplog.at_level("ERROR"):
        bundle = registry.load_bundle(require_person_det=False)
    assert bundle.uses_person_detector is False
    assert registry.FACE_EXPAND_TOKEN in bundle.version
    assert any(r.levelname == "ERROR" and "NOT FOUND" in r.getMessage() for r in caplog.records)


def test_default_is_service_safe(monkeypatch):
    """With no env set, the default must NOT raise — the live matcher would 500 on
    every search if a missing optional file were fatal."""
    registry = _fresh(monkeypatch)
    assert registry._env_flag("REQUIRE_PERSON_DET", False) is False


def test_env_flag_parsing(monkeypatch):
    registry = _fresh(monkeypatch)
    for raw, expected in (("1", True), ("true", True), ("YES", True), ("on", True),
                          ("0", False), ("false", False), ("", False)):
        monkeypatch.setenv("SOME_FLAG", raw)
        assert registry._env_flag("SOME_FLAG", False) is expected, raw
    monkeypatch.delenv("SOME_FLAG", raising=False)
    assert registry._env_flag("SOME_FLAG", True) is True


def test_cached_bundle_still_honours_a_stricter_caller(monkeypatch):
    """A tolerant caller must not decide for a strict one: whoever loaded first
    would otherwise let an indexer write face-expanded crops despite asking not to."""
    registry = _fresh(monkeypatch)
    registry.set_bundle(_bundle(registry, None))
    try:
        assert registry.load_bundle(require_person_det=False).uses_person_detector is False
        with pytest.raises(FileNotFoundError, match="already-loaded bundle has none"):
            registry.load_bundle(require_person_det=True)
    finally:
        registry.set_bundle(None)


def test_cached_bundle_with_detector_satisfies_both(monkeypatch):
    registry = _fresh(monkeypatch)
    registry.set_bundle(_bundle(registry, FakeModel()))
    try:
        assert registry.load_bundle(require_person_det=True).uses_person_detector is True
        assert registry.load_bundle(require_person_det=False).uses_person_detector is True
    finally:
        registry.set_bundle(None)


def test_model_version_is_not_exported_as_a_constant():
    """The constant was the bug: it could only ever guess. Keep it un-exported so
    nobody reintroduces a version that ignores what loaded."""
    import models

    assert "MODEL_VERSION" not in models.__all__
    assert hasattr(models, "model_version")
