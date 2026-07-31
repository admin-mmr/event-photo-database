"""
main.py — outfit-tagger service (Cloud Run, private).

Finds photos showing a described or exemplified outfit / accessory, given an
event that has been *prepared* (see job.py).

Endpoints:
  GET  /healthz            — liveness (no model load, so cold instances answer fast)
  GET  /status             — is this event prepared? how many crops, which versions?
  POST /detect             — samples and/or a text description → per-photo ranking

Relationship to Find-Me: none at runtime. This service has its own Cloud Run
deployment, its own URL, its own build context, and its own vector store under
`<eventId>/outfit/`. It READS two immutable artifacts the indexer already wrote
(the matcher manifest's boxes, the mirrored originals' pixels) and writes only
under its own prefix, so nothing here can degrade a Find-Me search. The api keeps
it behind its own `OUTFIT_URL`, which is empty until this is deployed.

Auth model: deployed WITHOUT --allow-unauthenticated; only api-runtime@ holds
roles/run.invoker and Cloud Run's IAM layer verifies the caller's ID token before
requests reach this code — identical to the matcher.

**What this can and cannot do**, so callers set expectations correctly:
  * Samples carry most of the signal. A handful of tight crops of the actual
    garment/accessory is the strong query.
  * Text is reliable for coarse visual attributes ("orange singlet", "yellow
    visor") and weak for fine-grained gear names ("open-ear headphones") — those
    words barely occur in the training captions. `/detect` reports
    `textAdvisory` when a description looks like the weak case.
  * Scores are z-scores against the event cohort (see scoring.py), NOT cosines,
    and no default threshold is applied. This is a ranking/shortlisting signal;
    it must not auto-confirm an identity.
"""

from __future__ import annotations

import logging
import os
import re
import threading

import numpy as np
from flask import Flask, jsonify, request

import crops as crops_mod
import scoring
import siglip
from images import decode_image
from store import OutfitStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("MAX_UPLOAD_BYTES", 25 * 1024 * 1024))

# Default share of the fused score that comes from the text description. Modest
# because samples are the stronger modality (module docstring); it only means
# anything at all because both sides are z-scored first (scoring.py).
DEFAULT_TEXT_WEIGHT = float(os.environ.get("OUTFIT_TEXT_WEIGHT", "0.35"))

# Result cap. There is no default score threshold — the guardrails require a
# judged sweep before a number gates anything — so a cap is what stops a query
# from returning the whole event ranked by similarity. Same role as the matcher's
# UNGATED_TOP_K.
DEFAULT_TOP_K = int(os.environ.get("OUTFIT_TOP_K", "100"))
MAX_TOP_K = int(os.environ.get("OUTFIT_MAX_TOP_K", "1000"))

# How many sample images one request may upload. Each one is a full encoder pass,
# and a prototype stops improving long before this.
MAX_SAMPLES = int(os.environ.get("OUTFIT_MAX_SAMPLES", "8"))

# Descriptions dominated by these read as fine-grained gear naming, which the text
# tower is bad at (module docstring). We do not refuse them — a caller may know
# better, and refusing would be us overriding their judgment — but we say so, so
# a weak result is interpreted as "text couldn't see it" rather than "not in the
# event".
_WEAK_TEXT_HINTS = (
    "headphone",
    "earphone",
    "earbud",
    "bone conduction",
    "open-ear",
    "open ear",
    "airpod",
    "shokz",
    "smartwatch",
    "watch",
    "brand",
    "logo",
)

_store: OutfitStore | None = None

# Per-event text calibration, keyed by (eventId, region, include_small). Computed
# once per process on the first text query for that slice (15 text embeds, ~a
# fraction of a second) and reused, because it depends only on the event's crops
# and the model — never on the query. See scoring.text_calibration.
_calibration: dict[tuple[str, str, bool], tuple[float, float]] = {}
_calibration_lock = threading.Lock()


def text_calibration_for(event_id: str, index, region: str | None, include_small: bool):
    key = (event_id, region or "*", include_small)
    cached = _calibration.get(key)
    if cached is not None:
        return cached
    with _calibration_lock:
        cached = _calibration.get(key)
        if cached is None:
            bundle = siglip.load_encoders()
            mask = index.region_mask(region, include_small)
            cached = scoring.text_calibration(index.vectors[mask], bundle.text.embed)
            logger.info(
                "text calibration for %s/%s: mean=%.4f std=%.4f over %d crops",
                event_id,
                region or "all",
                cached[0],
                cached[1],
                int(mask.sum()),
            )
            _calibration[key] = cached
        return cached


def reset_calibration() -> None:
    """Test hook / invalidation for a re-prepared event."""
    with _calibration_lock:
        _calibration.clear()


def get_store() -> OutfitStore:
    global _store
    if _store is None:
        root = os.environ.get("EMBEDDINGS_ROOT")
        if not root:
            raise RuntimeError("EMBEDDINGS_ROOT is not set")
        _store = OutfitStore(root)
    return _store


def set_store(store: OutfitStore | None) -> None:
    """Test hook."""
    global _store
    _store = store


def _form_int(name: str, default: int | None) -> int | None:
    raw = (request.form.get(name) or "").strip()
    if not raw:
        return default
    return int(raw)


def _form_float(name: str, default: float | None) -> float | None:
    raw = (request.form.get(name) or "").strip()
    if not raw:
        return default
    return float(raw)


def _form_bool(name: str, default: bool = False) -> bool:
    raw = (request.form.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def _text_advisory(text: str) -> str | None:
    lowered = text.lower()
    hit = next((h for h in _WEAK_TEXT_HINTS if h in lowered), None)
    if hit is None:
        return None
    return (
        f"the description mentions '{hit}', which the text encoder reads poorly — "
        "supply sample crops of it instead, and treat text-only results here as unreliable"
    )


@app.route("/healthz")
def healthz():
    return jsonify({"ok": True, "service": "outfit-tagger"})


@app.route("/status")
def status():
    """Is an event prepared, and with what? Cheap — reads index.json, no models."""
    event_id = (request.args.get("event_id") or "").strip()
    if not event_id:
        return jsonify({"error": "missing_event_id"}), 400
    store = get_store()
    if not store.is_prepared(event_id):
        return jsonify({"ok": True, "eventId": event_id, "prepared": False}), 200
    index = store.load_event(event_id)
    regions = {}
    for row in index.rows:
        regions[row.get("region")] = regions.get(row.get("region"), 0) + 1
    return jsonify(
        {
            "ok": True,
            "eventId": event_id,
            "prepared": True,
            "crops": len(index),
            "regions": regions,
            "photos": index.index.get("photos", 0),
            "modelVersion": index.model_version,
            "sourceModelVersion": index.source_model_version,
            "skipped": len(index.index.get("skipped", [])),
        }
    )


@app.route("/detect", methods=["POST"])
def detect():
    """Rank an event's crops against sample images and/or a text description.

    multipart/form-data:
      file               0..n sample images. Embedded WHOLE, so crop them tight to
                         the garment/accessory — a wide shot dilutes the prototype.
      event_id           required
      text               optional description
      text_weight        optional, default OUTFIT_TEXT_WEIGHT
      sample_photo_ids   optional comma-separated event photoIds; their stored
                         crop vectors are reused, costing no inference
      region             'person' | 'head' | 'auto' (default: auto = both)
      top_k              optional, default OUTFIT_TOP_K
      min_score          optional z-score cutoff (no default — see scoring.py)
      include_small      optional, include crops flagged too small to be useful
    """
    event_id = (request.form.get("event_id") or "").strip()
    if not event_id:
        return jsonify({"error": "missing_event_id"}), 400

    region = (request.form.get("region") or "auto").strip().lower()
    if region not in ("auto", *crops_mod.REGIONS):
        return jsonify({"error": "bad_region", "detail": f"region must be auto|{'|'.join(crops_mod.REGIONS)}"}), 400
    region_filter = None if region == "auto" else region

    try:
        top_k = _form_int("top_k", DEFAULT_TOP_K)
        min_score = _form_float("min_score", None)
        text_weight = _form_float("text_weight", DEFAULT_TEXT_WEIGHT)
    except ValueError:
        return jsonify({"error": "bad_number", "detail": "top_k/min_score/text_weight must be numeric"}), 400
    if top_k is not None:
        top_k = max(1, min(top_k, MAX_TOP_K))
    include_small = _form_bool("include_small", False)

    text = (request.form.get("text") or "").strip()
    uploads = [f for f in request.files.getlist("file") if f and f.filename]
    if len(uploads) > MAX_SAMPLES:
        return jsonify({"error": "too_many_samples", "detail": f"at most {MAX_SAMPLES} sample images"}), 400
    sample_photo_ids = [p for p in re.split(r"[,\s]+", request.form.get("sample_photo_ids") or "") if p]

    if not text and not uploads and not sample_photo_ids:
        return jsonify(
            {"error": "missing_query", "detail": "provide sample images, sample_photo_ids, and/or text"}
        ), 400

    store = get_store()
    try:
        index = store.load_event(event_id)
    except FileNotFoundError:
        return jsonify({"error": "event_not_prepared", "eventId": event_id}), 404
    if len(index) == 0:
        return jsonify(
            {"ok": True, "eventId": event_id, "modelVersion": index.model_version, "results": []}
        )

    bundle = siglip.load_encoders()
    if index.model_version and index.model_version != bundle.version:
        # A prepared index embedded under a different model is not comparable to
        # a query embedded under this one — the vectors are in different spaces.
        # Fail loudly: silently ranking across spaces produces plausible-looking
        # nonsense, which is worse than an error the caller can act on.
        return jsonify(
            {
                "error": "model_version_mismatch",
                "detail": (
                    f"event prepared with '{index.model_version}' but this service runs "
                    f"'{bundle.version}' — re-run the prepare job for this event"
                ),
                "eventId": event_id,
            }
        ), 409

    # ── build the queries ────────────────────────────────────────────────────
    sample_vecs: list[np.ndarray] = []
    for upload in uploads:
        try:
            img = decode_image(upload.read())
        except Exception:
            return jsonify({"error": "bad_image", "detail": f"could not decode {upload.filename}"}), 400
        sample_vecs.append(bundle.vision.embed(img))
    resolved_ids, unknown_ids = [], []
    for pid in sample_photo_ids:
        stored = index.vectors_for_photo(pid, region_filter)
        if len(stored) == 0:
            unknown_ids.append(pid)
            continue
        resolved_ids.append(pid)
        sample_vecs.extend(stored)
    sample_query = scoring.mean_unit(sample_vecs)

    text_query = None
    advisory = None
    if text:
        if bundle.text is None:
            return jsonify(
                {
                    "error": "text_unsupported",
                    "detail": "no text tower staged in MODEL_DIR — sample-image queries only",
                }
            ), 400
        text_query = bundle.text.embed(text)
        advisory = _text_advisory(text)

    if sample_query is None and text_query is None:
        # Every sample resolved to nothing (unknown photoIds, or samples that
        # cancelled out) and there is no text — there is no query to run.
        return jsonify(
            {
                "error": "empty_query",
                "detail": "no usable samples resolved and no text supplied",
                "unknownPhotoIds": unknown_ids,
            }
        ), 400

    # ── score ────────────────────────────────────────────────────────────────
    mask = index.region_mask(region_filter, include_small)
    if not mask.any():
        return jsonify(
            {
                "ok": True,
                "eventId": event_id,
                "modelVersion": index.model_version,
                "region": region,
                "results": [],
                "detail": "no crops match the region/size filter",
            }
        )

    # Samples: cohort z-score (image↔image, same distribution as the crops).
    sample_z = scoring.zscore(index.sims(sample_query), mask) if sample_query is not None else None
    # Text: a query-INDEPENDENT calibration, never a cohort z-score. Cohort
    # z-scoring text divides out the relevance signal and ranks absurd prompts
    # above plausible ones — see scoring.py's module docstring for the measurement.
    text_z = None
    calibration = None
    if text_query is not None:
        calibration = text_calibration_for(event_id, index, region_filter, include_small)
        text_z = scoring.scale(index.sims(text_query), *calibration)
    fused = scoring.fuse(sample_z, text_z, text_weight if text_weight is not None else DEFAULT_TEXT_WEIGHT)

    results = scoring.rank_photos(
        index,
        fused,
        mask,
        top_k,
        min_score,
        components={"sampleScore": sample_z, "textScore": text_z},
    )

    return jsonify(
        {
            "ok": True,
            "eventId": event_id,
            "modelVersion": index.model_version,
            "sourceModelVersion": index.source_model_version,
            "region": region,
            # Samples are z-scored against the event cohort; text is scaled by the
            # event's query-independent text background. Both land in "std above
            # background" units, which is what makes textWeight meaningful.
            "scoreUnit": "zscore",
            **(
                {"textCalibration": {"mean": round(calibration[0], 5), "std": round(calibration[1], 5)}}
                if calibration is not None
                else {}
            ),
            "textWeight": (text_weight if (text_query is not None and sample_query is not None) else None),
            "sampleCount": len(sample_vecs),
            "samplePhotoIds": resolved_ids,
            "unknownPhotoIds": unknown_ids,
            "cohortSize": int(mask.sum()),
            **({"textAdvisory": advisory} if advisory else {}),
            "results": results,
        }
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
