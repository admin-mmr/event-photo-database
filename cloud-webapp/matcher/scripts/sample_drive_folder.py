#!/usr/bin/env python3
"""
sample_drive_folder.py — pull a random N-photo sample from a Drive event
folder for the M0 spike (dev plan task 0.1: "~500 real event photos").

Auth = the verified G1 pattern (see infra/scripts/verify-g1-dwd.sh and
runbook §G1): keyless domain-wide delegation — your gcloud user signs a JWT
as indexer-runtime@, impersonating a Workspace user (sub), and exchanges it
for a Drive access token. Prereq (one-time, already done for admin@):

    gcloud iam service-accounts add-iam-policy-binding \
      indexer-runtime@mmr-data-pipeline.iam.gserviceaccount.com \
      --member="user:admin@mmrunners.org" \
      --role="roles/iam.serviceAccountTokenCreator"

Usage:
    python scripts/sample_drive_folder.py <EVENT_FOLDER_ID> \
        --out ~/event-sample-photos [--n 500] [--seed 42] [--flat]

Walks the folder recursively (image MIME types only), samples N uniformly,
and downloads. photoId in the local store will be the relative path; a
drive_manifest.json (photoId → Drive fileId) is written alongside so M1 can
reconcile these photos with Firestore later.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import time
import urllib.parse
import urllib.request

SA = os.environ.get("DWD_SA", "indexer-runtime@mmr-data-pipeline.iam.gserviceaccount.com")
SUBJECT = os.environ.get("DWD_SUBJECT", "admin@mmrunners.org")
DRIVE = "https://www.googleapis.com/drive/v3/files"
IMAGE_MIMES_PREFIX = "image/"


def dwd_token() -> str:
    """Sign a DWD assertion via gcloud (keyless) and exchange it for a token."""
    now = int(time.time())
    claims = json.dumps(
        {
            "iss": SA,
            "sub": SUBJECT,
            "scope": "https://www.googleapis.com/auth/drive.readonly",
            "aud": "https://oauth2.googleapis.com/token",
            "iat": now,
            "exp": now + 3600,
        }
    )
    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        f.write(claims)
        claims_path = f.name
    try:
        proc = subprocess.run(
            ["gcloud", "iam", "service-accounts", "sign-jwt", claims_path, "/dev/stdout",
             f"--iam-account={SA}"],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            print(f"gcloud sign-jwt failed:\n{proc.stderr}", file=sys.stderr)
            raise SystemExit(1)
        jwt = proc.stdout.strip()
    finally:
        os.unlink(claims_path)

    data = urllib.parse.urlencode(
        {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": jwt}
    ).encode()
    try:
        with urllib.request.urlopen("https://oauth2.googleapis.com/token", data=data) as resp:
            return json.load(resp)["access_token"]
    except urllib.error.HTTPError as e:
        print(f"Token exchange failed ({e.code}):\n{e.read().decode()}", file=sys.stderr)
        raise SystemExit(1)


def _get(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def list_images(folder_id: str, token: str, rel: str = "") -> list[dict]:
    """Recursively list image files. Returns [{id, name, relPath, mimeType}]."""
    items, page_token = [], None
    while True:
        q = f"'{folder_id}' in parents and trashed=false"
        params = {
            "q": q,
            "fields": "nextPageToken,files(id,name,mimeType)",
            "pageSize": 1000,
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }
        if page_token:
            params["pageToken"] = page_token
        page = _get(f"{DRIVE}?{urllib.parse.urlencode(params)}", token)
        for f in page.get("files", []):
            rel_path = f"{rel}{f['name']}"
            if f["mimeType"] == "application/vnd.google-apps.folder":
                items += list_images(f["id"], token, rel=f"{rel_path}/")
            elif f["mimeType"].startswith(IMAGE_MIMES_PREFIX):
                items.append({**f, "relPath": rel_path})
        page_token = page.get("nextPageToken")
        if not page_token:
            return items


def download(file_id: str, token: str, dest: str) -> None:
    url = f"{DRIVE}/{file_id}?alt=media&supportsAllDrives=true"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    with urllib.request.urlopen(req) as resp, open(dest, "wb") as f:
        while chunk := resp.read(1 << 20):
            f.write(chunk)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("folder_id", help="Drive event folder ID")
    parser.add_argument("--out", required=True)
    parser.add_argument("--n", type=int, default=500)
    parser.add_argument("--seed", type=int, default=42, help="reproducible sample")
    parser.add_argument("--flat", action="store_true",
                        help="flatten subfolders into one dir (name collisions get prefixed)")
    args = parser.parse_args()
    out = os.path.expanduser(args.out)

    print(f"Minting DWD token as {SA} (sub={SUBJECT})...")
    token = dwd_token()

    print("Listing folder (recursive)...")
    images = list_images(args.folder_id, token)
    print(f"  {len(images)} image files found")
    if not images:
        print("Nothing to sample.", file=sys.stderr)
        return 1

    random.Random(args.seed).shuffle(images)
    sample = sorted(images[: args.n], key=lambda f: f["relPath"])
    print(f"Sampling {len(sample)} (seed={args.seed}) → {out}")

    manifest, seen_names = {}, set()
    for i, f in enumerate(sample, 1):
        rel = f["relPath"]
        if args.flat:
            base = os.path.basename(rel)
            rel = f"{f['id'][:8]}_{base}" if base in seen_names else base
            seen_names.add(os.path.basename(rel))
        try:
            download(f["id"], token, os.path.join(out, rel))
        except Exception as exc:
            print(f"  SKIP {rel}: {exc}", file=sys.stderr)
            continue
        manifest[rel] = {"driveFileId": f["id"], "mimeType": f["mimeType"]}
        if i % 25 == 0:
            print(f"  {i}/{len(sample)}")

    with open(os.path.join(out, "drive_manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"folderId": args.folder_id, "seed": args.seed, "files": manifest}, f, indent=2)
    print(f"\nDone: {len(manifest)} photos + drive_manifest.json in {out}")
    print("Next: python scripts/embed_folder.py <out> --event-id ev_sample --out ./local_store")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
