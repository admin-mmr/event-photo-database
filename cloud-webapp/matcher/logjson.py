"""
logjson.py — one Cloud Logging entry per log record, at the record's severity.

The matcher logged plain text to stderr. Cloud Run splits a multi-line message
into separate entries and files a traceback's lines at ERROR — so every
`logger.warning(..., exc_info=True)`, an expected and handled failure, still
fired the severity>=ERROR alert email. It did on 2026-11-03 19:24: a background
store reload timed out, was handled (old copy served, retried later), and its
traceback arrived as 8 ERROR entries. As a single JSON line, the traceback rides
inside the message and Cloud Logging takes the severity from the `severity` field.
"""

from __future__ import annotations

import json
import logging
import sys


class CloudJsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        message = record.getMessage()
        if record.exc_info:
            message = f"{message}\n{self.formatException(record.exc_info)}"
        if record.stack_info:
            message = f"{message}\n{self.formatStack(record.stack_info)}"
        # Python's level names (DEBUG/INFO/WARNING/ERROR/CRITICAL) are all valid
        # Cloud Logging severities.
        return json.dumps(
            {"severity": record.levelname, "message": message, "logger": record.name},
            ensure_ascii=False,
            default=str,
        )


def configure(level: int = logging.INFO) -> None:
    """Route every logger through one stdout handler with the JSON formatter."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(CloudJsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
