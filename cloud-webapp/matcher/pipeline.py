"""
pipeline.py — image → face + person ("outfit") embeddings.

Used by the /embed and /search endpoints and by scripts/embed_folder.py
(the M0 stand-in for the M1 indexer Job; indexer/job.py will reuse this).
"""

from __future__ import annotations

import io

import numpy as np

from models import load_bundle
from models.common import expand_face_to_person
from quality import assess_face

MAX_IMAGE_PIXELS = 500_000_000  # decompression-bomb guard (same as cloud-run/main.py)


def decode_image(data: bytes) -> np.ndarray:
    """Decode image bytes → RGB uint8 array. EXIF orientation is baked in.
    HEIC/HEIF supported when pillow-heif is installed."""
    from PIL import Image, ImageOps

    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except ImportError:
        pass

    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)
    return np.asarray(img.convert("RGB"))


# EXIF Exif-IFD pointer (0x8769) and DateTimeOriginal (0x9003) tag ids.
_EXIF_IFD = 0x8769
_DATETIME_ORIGINAL = 0x9003


def read_capture_time_ms(data: bytes) -> int | None:
    """Parse EXIF DateTimeOriginal → epoch milliseconds, or None if absent /
    unparseable. Used only as the *query anchor* for capture-time-conditional
    fusion (PEOPLE_RECOGNITION_QUALITY_PLAN.md Item 1) — never for gallery
    ordering (that is the indexer's `capture_time` module → Firestore `takenAt`).

    EXIF DateTimeOriginal is naive local time ("YYYY:MM:DD HH:MM:SS"); we treat
    it as UTC to match how candidate `takenAtMs` is normalized in the manifest.
    The absolute offset cancels out in the query↔candidate delta as long as both
    sides use the same convention, so this only needs to be self-consistent.
    """
    from datetime import datetime, timezone

    from PIL import Image

    try:
        img = Image.open(io.BytesIO(data))
        exif = img.getexif()
        if not exif:
            return None
        raw = exif.get_ifd(_EXIF_IFD).get(_DATETIME_ORIGINAL)
        if not raw:
            return None
        dt = datetime.strptime(str(raw).strip(), "%Y:%m:%d %H:%M:%S").replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return None


def _iou(a: list[float], b: list[float]) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / max(area_a + area_b - inter, 1e-9)


def _face_in_person(face_box: list[float], person_box: list[float]) -> bool:
    """True if the face box center lies inside the person box."""
    cx = (face_box[0] + face_box[2]) / 2
    cy = (face_box[1] + face_box[3]) / 2
    return person_box[0] <= cx <= person_box[2] and person_box[1] <= cy <= person_box[3]


def embed_image(img_rgb: np.ndarray, bundle=None) -> dict:
    """Run the full pipeline on one image.

    Returns:
      {
        "faces":   [{box, score, quality, embedding(np.float32 512)}],
        "persons": [{box, score, source: "detector"|"face_expand",
                     face_idx: int|None, embedding(np.float32 dim)}],
        "model_version": str,
      }
    Persons are associated to faces (face_idx) when the face center falls
    inside the person box — fusion needs the pairing.
    """
    bundle = bundle or load_bundle()
    h, w = img_rgb.shape[:2]

    faces = []
    for det in bundle.face_det.detect(img_rgb):
        faces.append(
            {
                "box": det["box"],
                "score": det["score"],
                "quality": assess_face(img_rgb, det),
                "embedding": bundle.face_emb.embed(img_rgb, det["kps"]),
            }
        )

    if bundle.person_det is not None:
        person_dets = [
            {"box": d["box"], "score": d["score"], "source": "detector"}
            for d in bundle.person_det.detect(img_rgb)
        ]
    else:
        person_dets = [
            {
                "box": expand_face_to_person(f["box"], w, h),
                "score": f["score"],
                "source": "face_expand",
            }
            for f in faces
        ]

    persons = []
    for p in person_dets:
        x1, y1, x2, y2 = (int(round(v)) for v in p["box"])
        crop = img_rgb[max(0, y1) : max(1, y2), max(0, x1) : max(1, x2)]
        if crop.shape[0] < 8 or crop.shape[1] < 8:
            continue
        face_idx = next(
            (i for i, f in enumerate(faces) if _face_in_person(f["box"], p["box"])),
            None,
        )
        persons.append({**p, "face_idx": face_idx, "embedding": bundle.person_emb.embed(crop)})

    return {"faces": faces, "persons": persons, "model_version": bundle.version}
