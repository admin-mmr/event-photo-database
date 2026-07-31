#!/usr/bin/env python3
"""
sample_drive_videos.py — pull real volunteer clips out of a Drive event folder
for the Phase 0 video spike (VIDEO_FRAME_EXTRACTION_DEV_PLAN.md §2.3 Phase 0.1:
"~10 real clips spanning the hard cases").

The video sibling of sample_drive_folder.py, and it borrows that script's auth
verbatim (keyless DWD: your gcloud user signs a JWT as indexer-runtime@,
impersonating a Workspace user). Same one-time prereq — see that file's header.

Usage:
    python scripts/sample_drive_videos.py <EVENT_FOLDER_ID> --out ~/event-clips \\
        [--n 10] [--max-mb 400] [--seed 42] [--list-only]

Notes specific to video:
  * Clips reach GiB, so `--max-mb` (default 400) skips the monsters by default
    and `--list-only` shows you the inventory with sizes before anything is
    downloaded. Pass `--max-mb 0` for no cap.
  * Managed folders (Photos_NNN / Videos / Album) are NOT walked — they hold
    shortcuts and copies of the same content, so walking them would sample the
    same clip repeatedly. Same rule the indexer uses.
  * Shortcuts are skipped; their targets are reached as real files.
  * The sample is spread across the size range rather than uniform-random: a
    Phase 0 sample wants the hard cases (a 4K action-cam clip, a shaky phone
    clip) more than it wants a representative average.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sample_drive_folder import DRIVE, SA, SUBJECT, dwd_token  # noqa: E402

FOLDER_MIME = "application/vnd.google-apps.folder"
SHORTCUT_MIME = "application/vnd.google-apps.shortcut"
VIDEO_MIME_PREFIX = "video/"
# Kept in step with the api's isManagedFolderName: these hold deliberate copies
# and shortcuts, not source uploads.
MANAGED_PREFIXES = ("photos_", "videos", "album")


def is_managed(name: str) -> bool:
    low = name.strip().lower()
    return any(low == p or low.startswith(p) for p in MANAGED_PREFIXES)


def _get(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def list_videos(folder_id: str, token: str, rel: str = "") -> list[dict]:
    items, page_token = [], None
    while True:
        params = {
            "q": f"'{folder_id}' in parents and trashed=false",
            "fields": "nextPageToken,files(id,name,mimeType,size,videoMediaMetadata,createdTime)",
            "pageSize": 1000,
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }
        if page_token:
            params["pageToken"] = page_token
        page = _get(f"{DRIVE}?{urllib.parse.urlencode(params)}", token)
        for f in page.get("files", []):
            rel_path = f"{rel}{f['name']}"
            mime = f["mimeType"]
            if mime == FOLDER_MIME:
                if is_managed(f["name"]):
                    continue
                items += list_videos(f["id"], token, rel=f"{rel_path}/")
            elif mime == SHORTCUT_MIME:
                continue
            elif mime.startswith(VIDEO_MIME_PREFIX):
                items.append({**f, "relPath": rel_path})
        page_token = page.get("nextPageToken")
        if not page_token:
            return items


def download(file_id: str, token: str, dest: str) -> None:
    url = f"{DRIVE}/{file_id}?alt=media&supportsAllDrives=true"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    with urllib.request.urlopen(req) as resp, open(dest, "wb") as fh:
        while chunk := resp.read(1 << 20):
            fh.write(chunk)


def spread_sample(files: list[dict], n: int, seed: int) -> list[dict]:
    """Pick n clips spread across the size range (proxy for resolution/length),
    so the sample includes the extremes instead of averaging them away."""
    if len(files) <= n:
        return list(files)
    ordered = sorted(files, key=lambda f: int(f.get("size") or 0))
    buckets: list[list[dict]] = [[] for _ in range(n)]
    for i, f in enumerate(ordered):
        buckets[min(n - 1, i * n // len(ordered))].append(f)
    rng = random.Random(seed)
    return [rng.choice(b) for b in buckets if b]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder_id", help="Drive event folder ID")
    ap.add_argument("--out", help="download folder (required unless --list-only)")
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--max-mb", type=float, default=400.0, help="skip larger clips (0 = no cap)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--list-only", action="store_true",
                    help="print the inventory and exit, downloading nothing")
    a = ap.parse_args()

    if not a.list_only and not a.out:
        print("--out is required unless --list-only", file=sys.stderr)
        return 2

    print(f"Minting DWD token as {SA} (sub={SUBJECT})...")
    token = dwd_token()

    print("Listing folder (recursive, managed folders skipped)...")
    videos = list_videos(a.folder_id, token)
    print(f"  {len(videos)} video files found")
    if not videos:
        print("Nothing to sample.", file=sys.stderr)
        return 1

    def mb(f: dict) -> float:
        return int(f.get("size") or 0) / 1e6

    if a.list_only:
        for f in sorted(videos, key=lambda x: -int(x.get("size") or 0)):
            meta = f.get("videoMediaMetadata") or {}
            dims = (f"{meta.get('width')}x{meta.get('height')}"
                    if meta.get("width") else "?")
            dur = (f"{int(meta.get('durationMillis', 0)) / 1000:.0f}s"
                   if meta.get("durationMillis") else "?")
            print(f"  {mb(f):8.1f} MB  {dims:>10s}  {dur:>6s}  {f['relPath']}")
        total = sum(mb(f) for f in videos)
        print(f"\n  {len(videos)} clips, {total:.1f} MB total")
        return 0

    pool = videos if a.max_mb <= 0 else [f for f in videos if mb(f) <= a.max_mb]
    skipped = len(videos) - len(pool)
    if skipped:
        print(f"  {skipped} clip(s) over {a.max_mb:.0f} MB skipped "
              f"(--max-mb 0 to include them)")
    if not pool:
        print("Every clip is over the size cap.", file=sys.stderr)
        return 1

    sample = spread_sample(pool, a.n, a.seed)
    out = os.path.expanduser(a.out)
    print(f"Downloading {len(sample)} clip(s) ({sum(mb(f) for f in sample):.0f} MB) → {out}")

    manifest, seen = {}, set()
    for i, f in enumerate(sample, 1):
        base = os.path.basename(f["relPath"])
        name = f"{f['id'][:8]}_{base}" if base in seen else base
        seen.add(base)
        print(f"  [{i}/{len(sample)}] {mb(f):.0f} MB  {name}")
        try:
            download(f["id"], token, os.path.join(out, name))
        except Exception as exc:  # noqa: BLE001 — one bad clip shouldn't end the pull
            print(f"    SKIP: {exc}", file=sys.stderr)
            continue
        manifest[name] = {"driveFileId": f["id"], "mimeType": f["mimeType"],
                          "relPath": f["relPath"], "sizeBytes": int(f.get("size") or 0),
                          "videoMediaMetadata": f.get("videoMediaMetadata")}

    with open(os.path.join(out, "drive_manifest.json"), "w", encoding="utf-8") as fh:
        json.dump({"folderId": a.folder_id, "seed": a.seed, "files": manifest}, fh, indent=2)
    print(f"\nDone: {len(manifest)} clip(s) + drive_manifest.json in {out}")
    print(f"Next: python eval/run_video_spike.py --clips {out} --out /tmp/video-spike")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
