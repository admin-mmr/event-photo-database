"""Unit tests for DriveClient.list_images filtering (shortcuts + skip folders)."""

from __future__ import annotations

import contextlib
import io
import json

import pytest

import drive
from drive import DriveClient, FOLDER_MIME, SHORTCUT_MIME


def _fake_token_endpoint(token: str):
    """Stand in for the OAuth token exchange the non-key signers finish with."""

    @contextlib.contextmanager
    def fake_urlopen(url, data=None):  # noqa: ARG001
        yield io.BytesIO(json.dumps({"access_token": token}).encode())

    return fake_urlopen


def _img(fid: str, name: str) -> dict:
    return {"id": fid, "name": name, "mimeType": "image/jpeg", "md5Checksum": fid}


def _folder(fid: str, name: str) -> dict:
    return {"id": fid, "name": name, "mimeType": FOLDER_MIME}


def _shortcut(fid: str, name: str) -> dict:
    return {"id": fid, "name": name, "mimeType": SHORTCUT_MIME}


def _client_for(tree: dict[str, list[dict]]) -> DriveClient:
    """Build a DriveClient whose _get_json serves a fake folder tree keyed by
    parent folder id (single page per folder, no pagination)."""
    c = DriveClient(token="fake")

    def fake_get_json(url: str) -> dict:
        # url is .../files?q='<folder_id>' in parents and ...
        import urllib.parse as up

        q = up.parse_qs(up.urlparse(url).query)["q"][0]
        folder_id = q.split("'")[1]
        return {"files": tree.get(folder_id, [])}

    c._get_json = fake_get_json  # type: ignore[assignment]
    return c


def test_skips_shortcuts_and_zzz_folder(monkeypatch):
    monkeypatch.setattr(drive, "SKIP_FOLDER_NAMES", frozenset({"photos_zzz"}))
    tree = {
        "root": [
            _img("a", "real1.jpg"),
            _shortcut("s1", "shortcut1.jpg"),
            _folder("photos", "Photos"),
            _folder("zzz", "Photos_zzz"),
        ],
        "photos": [_img("b", "real2.jpg"), _shortcut("s2", "shortcut2.jpg")],
        "zzz": [_img("dup1", "real1.jpg"), _shortcut("s3", "shortcut3.jpg")],
    }
    got = _client_for(tree).list_images("root")
    ids = sorted(f["id"] for f in got)
    assert ids == ["a", "b"]  # real images only; shortcuts + Photos_zzz excluded


def test_skips_managed_photos_videos_album_folders(monkeypatch):
    """The api creates Photos_NNN / Videos / Album inside the event folder. A
    non-JPEG photo is materialised there as a real converted JPG (not a
    shortcut), so recursing in would index it a second time — and rename it
    under CAPTURE_TIME_RENAME=1."""
    monkeypatch.setattr(drive, "SKIP_FOLDER_NAMES", frozenset())
    tree = {
        "root": [
            _img("a", "real1.jpg"),
            _folder("p1", "Photos_001"),
            _folder("vid", "Videos"),
            _folder("alb", "Album"),
            _folder("club", "Photos"),  # a normal upload folder, NOT managed
        ],
        "p1": [_img("copy1", "real1.jpg"), _shortcut("s1", "real1.jpg")],
        "vid": [_shortcut("s2", "clip.mp4")],
        "alb": [_shortcut("s3", "real1.jpg")],
        "club": [_img("b", "real2.jpg")],
    }
    got = _client_for(tree).list_images("root")
    assert sorted(f["id"] for f in got) == ["a", "b"]


def test_is_skipped_folder_rules(monkeypatch):
    monkeypatch.setattr(drive, "SKIP_FOLDER_NAMES", frozenset({"extra_skip"}))
    for name in ("Photos_001", "photos_zzz", "  PHOTOS_042 ", "Videos", "album", "extra_skip"):
        assert drive.is_skipped_folder(name), name
    for name in ("Photos", "PhotosOfMe", "Video", "Albums", "MMR"):
        assert not drive.is_skipped_folder(name), name


def test_skip_folder_match_is_case_insensitive(monkeypatch):
    monkeypatch.setattr(drive, "SKIP_FOLDER_NAMES", frozenset({"photos_zzz"}))
    tree = {
        "root": [_img("a", "keep.jpg"), _folder("zzz", "  photos_ZZZ  ")],
        "zzz": [_img("dup", "dropme.jpg")],
    }
    got = _client_for(tree).list_images("root")
    assert [f["id"] for f in got] == ["a"]


# --- DWD signer selection (AZ1: the indexer must authenticate off GCP too) ---


def _reset_key_cache(monkeypatch):
    """The parsed key is cached module-wide; each test starts from unset."""
    monkeypatch.setattr(drive, "_SA_KEY_CACHE", drive._UNSET, raising=False)


def _fake_key(email: str = "indexer-runtime@mmr-data-pipeline.iam.gserviceaccount.com") -> str:
    import json as _json

    return _json.dumps({"client_email": email, "private_key": "-----BEGIN PRIVATE KEY-----\nx\n"})


def test_no_key_keeps_the_gcp_signer_chain(monkeypatch):
    """With GOOGLE_SA_KEY_JSON unset, every GCP run must behave exactly as before."""
    _reset_key_cache(monkeypatch)
    monkeypatch.delenv("GOOGLE_SA_KEY_JSON", raising=False)
    calls: list[str] = []
    monkeypatch.setattr(drive, "_sign_jwt_iam", lambda sa, claims: calls.append("iam") or "jwt")
    monkeypatch.setattr(
        drive,
        "_dwd_token_from_key",
        lambda *a, **k: pytest.fail("key signer must not run without a key"),
    )
    monkeypatch.setattr(drive.urllib.request, "urlopen", _fake_token_endpoint("tok-gcp"))

    assert drive.dwd_token() == "tok-gcp"
    assert calls == ["iam"]


def test_key_present_signs_locally_and_skips_iam(monkeypatch):
    _reset_key_cache(monkeypatch)
    monkeypatch.setenv("GOOGLE_SA_KEY_JSON", _fake_key())
    monkeypatch.setattr(
        drive, "_sign_jwt_iam", lambda *a, **k: pytest.fail("must not call IAM when a key is set")
    )
    monkeypatch.setattr(
        drive,
        "_sign_jwt_gcloud",
        lambda *a, **k: pytest.fail("must not shell out to gcloud when a key is set"),
    )
    seen: dict = {}

    def fake_from_key(key, subject, scope):
        seen.update(email=key["client_email"], subject=subject, scope=scope)
        return "tok-azure"

    monkeypatch.setattr(drive, "_dwd_token_from_key", fake_from_key)

    assert drive.dwd_token(subject="admin@mmrunners.org") == "tok-azure"
    assert seen["subject"] == "admin@mmrunners.org"
    assert seen["scope"] == drive.SCOPE


def test_key_path_carries_the_write_scope_through(monkeypatch):
    """CAPTURE_TIME_RENAME needs SCOPE_RW; the key path must not pin read-only."""
    _reset_key_cache(monkeypatch)
    monkeypatch.setenv("GOOGLE_SA_KEY_JSON", _fake_key())
    seen: dict = {}
    monkeypatch.setattr(
        drive,
        "_dwd_token_from_key",
        lambda key, subject, scope: seen.update(scope=scope) or "tok",
    )

    drive.dwd_token(scope=drive.SCOPE_RW)
    assert seen["scope"] == drive.SCOPE_RW


def test_malformed_key_fails_loudly(monkeypatch):
    """A bad key must raise here, not fall through to a gcloud that isn't installed."""
    _reset_key_cache(monkeypatch)
    monkeypatch.setenv("GOOGLE_SA_KEY_JSON", "{not json")
    monkeypatch.setattr(
        drive, "_sign_jwt_gcloud", lambda *a, **k: pytest.fail("must not reach the gcloud fallback")
    )
    with pytest.raises(RuntimeError, match="not valid JSON"):
        drive.dwd_token()


def test_key_missing_required_fields_is_rejected(monkeypatch):
    _reset_key_cache(monkeypatch)
    monkeypatch.setenv("GOOGLE_SA_KEY_JSON", '{"client_email": "a@b.com"}')
    with pytest.raises(RuntimeError, match="client_email \\+ private_key"):
        drive.dwd_token()


def test_blank_key_is_treated_as_absent(monkeypatch):
    """An env var set to "" (a common Key Vault / Container Apps artefact) is not a key."""
    _reset_key_cache(monkeypatch)
    monkeypatch.setenv("GOOGLE_SA_KEY_JSON", "   ")
    monkeypatch.setattr(drive, "_sign_jwt_iam", lambda sa, claims: "jwt")
    monkeypatch.setattr(drive.urllib.request, "urlopen", _fake_token_endpoint("tok-gcp"))

    assert drive.dwd_token() == "tok-gcp"
