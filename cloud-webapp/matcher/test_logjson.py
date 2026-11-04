"""logjson — a handled failure's traceback must not reach Cloud Logging as ERROR."""

import json
import logging

from logjson import CloudJsonFormatter


def _format(level: int, exc: bool) -> dict:
    logger = logging.getLogger("t")
    try:
        raise OSError("Connection broken: IncompleteRead")
    except OSError:
        record = logger.makeRecord("t", level, __file__, 1, "store reload failed for %s", ("e1",), None)
        if exc:
            import sys

            record.exc_info = sys.exc_info()
    return json.loads(CloudJsonFormatter().format(record))


def test_a_warning_with_a_traceback_is_one_warning_entry():
    out = _format(logging.WARNING, exc=True)
    assert out["severity"] == "WARNING"
    assert out["message"].startswith("store reload failed for e1\nTraceback")
    assert "IncompleteRead" in out["message"]


def test_plain_records_keep_their_level():
    assert _format(logging.INFO, exc=False) == {
        "severity": "INFO",
        "message": "store reload failed for e1",
        "logger": "t",
    }
    assert _format(logging.ERROR, exc=False)["severity"] == "ERROR"
