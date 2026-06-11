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


def _claims(sa: str, subject: str) -> str:
    now = int(time.time())
    return json.dumps(
        {"iss": sa, "sub": subject, "scope": SCOPE, "aud": TOKEN_URL, "iat": now, "exp": now + 3600}
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


def dwd_token(sa: str | None = None, subject: str | None = None) -> str:
    """Mint a Drive access token via keyless DWD."""
    sa = sa or os.environ.get("DWD_SA", DEFAULT_SA)
    subject = subject or os.environ.get("DWD_SUBJECT", DEFAULT_SUBJECT)
    claims = _claims(sa, subject)
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

    def _auth(self) -> str:
        if self._token is None:
            self._token = dwd_token()
        return self._token

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

    def list_images(self, folder_id: str, rel: str = "") -> list[dict]:
        """Recursively list image files in a folder.

        Returns [{id, name, relPath, mimeType, md5Checksum, modifiedTime, size}].
        Shortcuts are not followed (the gas-app dedupe work showed shortcut
        targets also appear as real files elsewhere in the tree).
        """
        items: list[dict] = []
        page_token = None
        while True:
            params = {
                "q": f"'{folder_id}' in parents and trashed=false",
                "fields": ("nextPageToken,files(id,name,mimeType,md5Checksum,"
                           "modifiedTime,size)"),
                "pageSize": 1000,
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
            }
            if page_token:
                params["pageToken"] = page_token
            page = self._get_json(f"{DRIVE}?{urllib.parse.urlencode(params)}")
            for f in page.get("files", []):
                rel_path = f"{rel}{f['name']}"
                if f["mimeType"] == "application/vnd.google-apps.folder":
                    items += self.list_images(f["id"], rel=f"{rel_path}/")
                elif f["mimeType"].startswith("image/"):
                    items.append({**f, "relPath": rel_path})
            page_token = page.get("nextPageToken")
            if not page_token:
                return items

    def download(self, file_id: str) -> bytes:
        url = f"{DRIVE}/{file_id}?alt=media&supportsAllDrives=true"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self._auth()}"})
        with urllib.request.urlopen(req) as resp:
            chunks = []
            while chunk := resp.read(1 << 20):
                chunks.append(chunk)
            return b"".join(chunks)
