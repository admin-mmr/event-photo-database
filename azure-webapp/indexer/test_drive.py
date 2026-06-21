"""Unit tests for DriveClient.list_images filtering (shortcuts + skip folders)."""

from __future__ import annotations

import drive
from drive import DriveClient, FOLDER_MIME, SHORTCUT_MIME


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


def test_skip_folder_match_is_case_insensitive(monkeypatch):
    monkeypatch.setattr(drive, "SKIP_FOLDER_NAMES", frozenset({"photos_zzz"}))
    tree = {
        "root": [_img("a", "keep.jpg"), _folder("zzz", "  photos_ZZZ  ")],
        "zzz": [_img("dup", "dropme.jpg")],
    }
    got = _client_for(tree).list_images("root")
    assert [f["id"] for f in got] == ["a"]
