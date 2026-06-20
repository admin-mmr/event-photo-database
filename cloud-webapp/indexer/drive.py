"""
drive.py — Drive read access for the indexer (M1.2/M1.3).

Auth = keyless domain-wide delegation, the verified G1 pattern
(runbook §G1, `infra/scripts/verify-g1-dwd.sh`,
`matcher/scripts/sample_drive_folder.py`): a JWT is signed as
indexer-runtime@ with `sub=<workspace user>` and exchanged for a Drive
access token. No SA key files anywhere.

Two signers, auto-selected:
  - on Cloud Run / with ADC: IAM Credentials `signJwt` REST call
    (the runtime SA needs roles/iam.serviceAccountTokenCreator **on itself**)
  - local dev fallback: `gcloud iam service-accounts sign-jwt`
    (your gcloud user needs tokenCreator on the SA — already granted for admin@)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

DEFAULT_SA = "indexer-runtime@mmr-data-pipeline.iam.gserviceaccount.com"
DEFAULT_SUBJECT = "admin@mmrunners.org"
DRIVE = "https://www.googleapis.com/drive/v3/files"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/drive.readonly"

FOLDER_MIME = "application/vnd.google-apps.folder"
SHORTCUT_MIME = "application/vnd.google-apps.shortcut"

# Folders that hold shortcuts / duplicate copies rather than original photos.
# We never recurse into them, so only real photo files in the event's normal
# folders get indexed (avoids the duplicate-photo inflation those folders cause).
# Matched case-insensitively on the folder's display name. Override via the
# SKIP_FOLDER_NAMES env var (comma-separated) if the convention changes.
SKIP_FOLDER_NAMES = frozenset(
    n.strip().lower()
    for n in os.environ.get("SKIP_FOLDER_NAMES", "Photos_zzz").split(",")
    if n.strip()
)


# Read-write scope, needed only for the capture-time rename (files.update).
# Must be added to the DWD client's allowed scopes in the Workspace Admin
# console alongside the read-only one (UPLOAD_RESUMABLE_NOTES / CAPTURE_TIME).
SCOPE_RW = "https://www.googleapis.com/auth/drive"


def _claims(sa: str, subject: str, scope: str = SCOPE) -> str:
    now = int(time.time())
    return json.dumps(
        {"iss": sa, "sub": subject, "scope": scope, "aud": TOKEN_URL, "iat": now, "exp": now + 3600}
    )


def _sign_jwt_iam(sa: str, claims: str) -> str:
    """Sign via IAM Credentials API using ADC (Cloud Run path)."""
    import google.auth
    from google.auth.transport.requests import AuthorizedSession

    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    session = AuthorizedSession(creds)
    resp = session.post(
        f"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{sa}:signJwt",
        json={"payload": claims},
    )
    resp.raise_for_status()
    return resp.json()["signedJwt"]


def _sign_jwt_gcloud(sa: str, claims: str) -> str:
    """Sign via the gcloud CLI (local dev path)."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        f.write(claims)
        path = f.name
    try:
        return subprocess.run(
            ["gcloud", "iam", "service-accounts", "sign-jwt", path, "/dev/stdout",
             f"--iam-account={sa}"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
    finally:
        os.unlink(path)


def dwd_token(sa: str | None = None, subject: str | None = None, scope: str = SCOPE) -> str:
    """Mint a Drive access token via keyless DWD."""
    sa = sa or os.environ.get("DWD_SA", DEFAULT_SA)
    subject = subject or os.environ.get("DWD_SUBJECT", DEFAULT_SUBJECT)
    claims = _claims(sa, subject, scope)
    try:
        jwt = _sign_jwt_iam(sa, claims)
    except Exception:
        jwt = _sign_jwt_gcloud(sa, claims)
    data = urllib.parse.urlencode(
        {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": jwt}
    ).encode()
    with urllib.request.urlopen(TOKEN_URL, data=data) as resp:
        return json.load(resp)["access_token"]


class DriveClient:
    """Minimal Drive v3 reader. Token refreshed lazily on 401."""

    def __init__(self, token: str | None = None):
        self._token = token
        self._rw_token: str | None = None

    def _auth(self) -> str:
        if self._token is None:
            self._token = dwd_token()
        return self._token

    def _auth_rw(self) -> str:
        """Read-write token, minted lazily — only the rename path needs it, so
        a read-only deployment (no rw scope granted yet) is unaffected until
        CAPTURE_TIME_RENAME is turned on."""
        if self._rw_token is None:
            self._rw_token = dwd_token(scope=SCOPE_RW)
        return self._rw_token

    def _get_json(self, url: str) -> dict:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self._auth()}"})
        try:
            with urllib.request.urlopen(req) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code == 401:  # token expired mid-run → refresh once
                self._token = None
                req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self._auth()}"})
                with urllib.request.urlopen(req) as resp:
                    return json.load(resp)
            raise

    def get_folder_name(self, folder_id: str) -> str:
        """Display name of a Drive folder (used to label the event — B5).

        Returns "" on any error so a metadata hiccup never fails an index run.
        """
        try:
            params = {"fields": "name", "supportsAllDrives": "true"}
            meta = self._get_json(f"{DRIVE}/{folder_id}?{urllib.parse.urlencode(params)}")
            return str(meta.get("name", "") or "")
        except Exception:  # noqa: BLE001 — best-effort; naming is non-critical
            return ""

    def list_images(self, folder_id: str, rel: str = "") -> list[dict]:
        """Recursively list real image files in a folder.

        Returns [{id, name, relPath, mimeType, md5Checksum, modifiedTime, size}].

        Two things are deliberately excluded so only real photo files are
        indexed:
          - Shortcut files (mimeType application/vnd.google-apps.shortcut) are
            never indexed — their targets appear as real files elsewhere in the
            tree, so indexing the shortcut too would double-count the photo.
          - Folders named in SKIP_FOLDER_NAMES (e.g. "Photos_zzz") are not
            recursed into; those hold the shortcut/duplicate copies.
        """
        items: list[dict] = []
        page_token = None
        while True:
            params = {
                "q": f"'{folder_id}' in parents and trashed=false",
                "fields": ("nextPageToken,files(id,name,mimeType,md5Checksum,"
                           "modifiedTime,createdTime,size,"
                           "imageMediaMetadata(time))"),
                "pageSize": 1000,
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
            }
            if page_token:
                params["pageToken"] = page_token
            page = self._get_json(f"{DRIVE}?{urllib.parse.urlencode(params)}")
            for f in page.get("files", []):
                mime = f["mimeType"]
                rel_path = f"{rel}{f['name']}"
                if mime == FOLDER_MIME:
                    if f["name"].strip().lower() in SKIP_FOLDER_NAMES:
                        continue  # shortcut/duplicate folder — don't index it
                    items += self.list_images(f["id"], rel=f"{rel_path}/")
                elif mime == SHORTCUT_MIME:
                    continue  # never index shortcuts (targets exist as real files)
                elif mime.startswith("image/"):
                    items.append({**f, "relPath": rel_path})
            page_token = page.get("nextPageToken")
            if not page_token:
                return items

    def download(self, file_id: str) -> bytes:
        # Refresh the token once on 401 (same as _get_json): the DWD access
        # token lives ~1h, and a large event's downloads outlast it. Without
        # this, every download after expiry 401s and the photo is skipped.
        url = f"{DRIVE}/{file_id}?alt=media&supportsAllDrives=true"
        for attempt in (1, 2):
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self._auth()}"})
            try:
                with urllib.request.urlopen(req) as resp:
                    chunks = []
                    while chunk := resp.read(1 << 20):
                        chunks.append(chunk)
                    return b"".join(chunks)
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt == 1:  # token expired mid-run → refresh once
                    self._token = None
                    continue
                raise
        raise RuntimeError("unreachable")  # loop always returns or raises

    def rename(self, file_id: str, new_name: str, modified_time: str | None = None) -> None:
        """Rename a Drive file (and optionally stamp its modifiedTime) via
        files.update. Needs the read-write scope. `modified_time` is normalized
        to RFC3339 (a zone-less capture time is labelled 'Z' so Drive accepts
        it; ordering is preserved since all files are treated alike)."""
        body: dict = {"name": new_name}
        if modified_time:
            ts = modified_time
            if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$", ts):
                ts = ts + "Z"
            body["modifiedTime"] = ts
        params = {"supportsAllDrives": "true", "fields": "id,name"}
        url = f"{DRIVE}/{file_id}?{urllib.parse.urlencode(params)}"
        data = json.dumps(body).encode("utf-8")
        for attempt in (1, 2):
            req = urllib.request.Request(
                url, data=data, method="PATCH",
                headers={"Authorization": f"Bearer {self._auth_rw()}",
                         "Content-Type": "application/json"},
            )
            try:
                with urllib.request.urlopen(req) as resp:
                    json.load(resp)
                    return
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt == 1:
                    self._rw_token = None
                    continue
                raise
        raise RuntimeError("unreachable")
