#!/usr/bin/env bash
#
# recaptcha-score-report.sh — READ-ONLY. Summarises the `recaptcha verdict`
# log lines event-photo-api writes for every gated request (download,
# findme_search), so RECAPTCHA_MIN_SCORE can be chosen from real traffic while
# RECAPTCHA_MODE=shadow (BOT_PROTECTION_PLAN.md).
#
# Per action it prints: outcome counts (pass / would_block / blocked /
# fail_open), the reason mix (missing_token, low_score, MALFORMED, …), a score
# histogram, and how many scored requests each candidate threshold would block.
#
# Usage:
#   ./infra/scripts/recaptcha-score-report.sh [project-id] [freshness]
#   e.g. ./infra/scripts/recaptcha-score-report.sh mmr-data-pipeline 7d
#
# A wall of `fail_open` / reason `http_400` means the API key is still broken
# (see the `recaptcha_broken` ERROR lines) — fix that before reading scores.

set -euo pipefail

PROJECT_ID="${1:-mmr-data-pipeline}"
FRESHNESS="${2:-7d}"
LIMIT="${LIMIT:-50000}"

FILTER='resource.type="cloud_run_revision" AND resource.labels.service_name="event-photo-api" AND jsonPayload.message="recaptcha verdict"'

echo "==> Reading up to ${LIMIT} verdict lines from the last ${FRESHNESS} (${PROJECT_ID})" >&2
gcloud logging read "$FILTER" \
  --project="$PROJECT_ID" --freshness="$FRESHNESS" --limit="$LIMIT" \
  --format='json(jsonPayload.recaptcha)' \
| python3 -I -c '
import collections, json, sys

rows = [e.get("jsonPayload", {}).get("recaptcha") or {} for e in json.load(sys.stdin)]
if not rows:
    print("No verdict lines found. Is the shadow-mode build deployed, and has anyone searched/downloaded?")
    sys.exit(0)

by_action = collections.defaultdict(list)
for r in rows:
    by_action[r.get("action", "?")].append(r)

THRESHOLDS = (0.1, 0.3, 0.5, 0.7, 0.9)
for action, rs in sorted(by_action.items()):
    n = len(rs)
    print(f"\n=== {action}: {n} verdicts ===")
    for k, v in collections.Counter(r.get("outcome") for r in rs).most_common():
        print(f"  outcome {k!s:<12} {v:>7}  {100*v/n:5.1f}%")
    for k, v in collections.Counter(r.get("reason") for r in rs).most_common(8):
        print(f"  reason  {k!s:<20} {v:>7}  {100*v/n:5.1f}%")
    scores = [r["score"] for r in rs if isinstance(r.get("score"), (int, float))]
    if not scores:
        print("  (no scores — every assessment failed or had no token)")
        continue
    print(f"  score histogram ({len(scores)} scored):")
    for s, v in sorted(collections.Counter(round(s, 1) for s in scores).items()):
        print(f"    {s:.1f} {v:>7}  {chr(9608) * max(1, round(40 * v / len(scores)))}")
    print("  would block at MIN_SCORE =")
    for t in THRESHOLDS:
        b = sum(1 for s in scores if s < t)
        print(f"    {t:.1f}: {b:>7} of {len(scores)} scored  ({100*b/len(scores):5.1f}%)")
'
