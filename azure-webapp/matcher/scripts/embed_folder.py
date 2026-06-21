#!/usr/bin/env python3
"""
embed_folder.py — M0 indexing stand-in: embed a folder of event photos and
write the flat-file embedding store (faces.npy / persons.npy / manifest.json).

The M1 indexer Job (indexer/job.py) will reuse pipeline.embed_image and
store.build_manifest/write_local; this script is the local spike version
(dev plan M0 task 0.1/0.2: "embed a sample of ~500 real event photos").

Usage:
    python scripts/embed_folder.py <photos_dir> --event-id ev_test --out ./local_store
    # then optionally publish:
    python scripts/embed_folder.py <photos_dir> --event-id ev_test --out ./local_store \
        --upload gs://mmr-data-pipeline-derivatives

photoId = path of the file relative to <photos_dir> (matches what the M1
indexer will key Firestore `photos` docs on until Drive fileIds are wired in).
"""

from __future__ import annotations

import argparse
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models import load_bundle  # noqa: E402
from pipeline import decode_image, embed_image  # noqa: E402
from store import EMB_SUBDIR, build_manifest, write_local  # noqa: E402

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp", ".tiff"}


def iter_photos(root: str):
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in sorted(filenames):
            if os.path.splitext(name)[1].lower() in IMAGE_EXTS:
                full = os.path.join(dirpath, name)
                yield os.path.relpath(full, root), full


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("photos_dir")
    parser.add_argument("--event-id", required=True)
    parser.add_argument("--out", default="./local_store", help="local store root")
    parser.add_argument("--upload", default="", help="gs://bucket[/prefix] to publish to")
    parser.add_argument("--limit", type=int, default=0, help="cap photo count (0 = all)")
    args = parser.parse_args()

    bundle = load_bundle()
    faces_vecs, faces_meta = [], []
    persons_vecs, persons_meta = [], []
    t0 = time.time()
    count = skipped = 0

    for photo_id, path in iter_photos(args.photos_dir):
        if args.limit and count >= args.limit:
            break
        try:
            with open(path, "rb") as f:
                img = decode_image(f.read())
            result = embed_image(img, bundle=bundle)
        except Exception as exc:  # keep indexing; report at the end
            print(f"  SKIP {photo_id}: {exc}", file=sys.stderr)
            skipped += 1
            continue
        for f_ in result["faces"]:
            faces_vecs.append(f_["embedding"])
            faces_meta.append({"photoId": photo_id, "box": f_["box"], "score": f_["score"]})
        for p in result["persons"]:
            persons_vecs.append(p["embedding"])
            persons_meta.append(
                {"photoId": photo_id, "box": p["box"], "score": p["score"], "source": p["source"]}
            )
        count += 1
        if count % 25 == 0:
            print(f"  {count} photos · {len(faces_meta)} faces · {len(persons_meta)} persons · {time.time()-t0:.0f}s")

    face_dim = bundle.face_emb.dim
    person_dim = bundle.person_emb.dim
    faces = np.array(faces_vecs, dtype=np.float32) if faces_vecs else np.zeros((0, face_dim), np.float32)
    persons = np.array(persons_vecs, dtype=np.float32) if persons_vecs else np.zeros((0, person_dim), np.float32)
    manifest = build_manifest(args.event_id, bundle.version, faces_meta, persons_meta)

    event_dir = os.path.join(args.out, args.event_id)
    write_local(event_dir, manifest, faces, persons)
    print(
        f"\nIndexed {count} photos ({skipped} skipped) → {len(faces_meta)} faces, "
        f"{len(persons_meta)} persons in {time.time()-t0:.0f}s\n"
        f"Wrote {os.path.join(event_dir, EMB_SUBDIR)}/"
    )

    if args.upload:
        from google.cloud import storage

        without = args.upload[len("gs://"):]
        bucket_name, _, prefix = without.partition("/")
        bucket = storage.Client().bucket(bucket_name)
        base = "/".join(p for p in (prefix, args.event_id, EMB_SUBDIR) if p)
        local_dir = os.path.join(event_dir, EMB_SUBDIR)
        for name in os.listdir(local_dir):
            bucket.blob(f"{base}/{name}").upload_from_filename(os.path.join(local_dir, name))
            print(f"  uploaded gs://{bucket_name}/{base}/{name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
