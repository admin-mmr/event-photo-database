#!/usr/bin/env python3
"""
make_review_page.py — generate a static HTML page to visually review the
photos retrieved by the eval (face mode), per person.

Green border = already in labels.csv. Tick the checkbox under any photo that
really shows the person, then click "Copy CSV rows" and paste the rows into
eval/labels.csv. Rerun the eval after.

Usage:
    python eval/make_review_page.py --report eval/report.json \
        --photos-dir /path/to/event/photos --out eval/review.html

Requires a report.json produced by the current run_eval.py (with per-photo
"retrieved" lists). Open the resulting review.html directly in a browser.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import sys

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Match review</title>
<style>
  body {{ font-family: system-ui, sans-serif; margin: 20px; background: #fafafa; }}
  h2 {{ margin-top: 32px; }}
  .grid {{ display: flex; flex-wrap: wrap; gap: 12px; }}
  .card {{ width: 220px; background: #fff; border-radius: 8px; padding: 8px;
           box-shadow: 0 1px 3px rgba(0,0,0,.15); }}
  .card img {{ width: 100%; height: 160px; object-fit: cover; border-radius: 4px;
               border: 3px solid transparent; cursor: zoom-in; }}
  #lightbox {{ display: none; position: fixed; inset: 0; background: rgba(0,0,0,.85);
               z-index: 10; cursor: zoom-out; align-items: center; justify-content: center; }}
  #lightbox img {{ max-width: 95vw; max-height: 95vh; object-fit: contain; }}
  .card.labeled img {{ border-color: #2e9e44; }}
  .card .name {{ font-size: 11px; word-break: break-all; color: #555; margin: 4px 0; }}
  .badge {{ font-size: 11px; font-weight: 600; color: #2e9e44; }}
  button {{ position: fixed; bottom: 20px; right: 20px; padding: 12px 18px;
            font-size: 14px; border: 0; border-radius: 8px; background: #1a73e8;
            color: #fff; cursor: pointer; }}
  textarea {{ position: fixed; bottom: 70px; right: 20px; width: 420px; height: 140px;
              display: none; font-family: monospace; font-size: 12px; }}
</style></head><body>
<h1>Retrieved photos (face mode) — tick real matches</h1>
<p>Green border = already in labels.csv. Tick unlabeled photos that really show
the person, then click the button and append the CSV rows to eval/labels.csv.</p>
{sections}
<div id="lightbox" onclick="this.style.display='none'"><img id="lightbox-img" src=""></div>
<textarea id="csv" readonly></textarea>
<button onclick="exportCsv()">Copy CSV rows</button>
<script>
document.querySelectorAll('.card img').forEach(img => {{
  img.addEventListener('click', () => {{
    document.getElementById('lightbox-img').src = img.src;
    document.getElementById('lightbox').style.display = 'flex';
  }});
}});
document.addEventListener('keydown', e => {{
  if (e.key === 'Escape') document.getElementById('lightbox').style.display = 'none';
}});
function exportCsv() {{
  const rows = [...document.querySelectorAll('input[type=checkbox]:checked')]
    .map(cb => cb.dataset.photo + ',' + cb.dataset.person);
  const ta = document.getElementById('csv');
  ta.style.display = 'block';
  ta.value = rows.join('\\n');
  ta.select();
  navigator.clipboard?.writeText(ta.value);
}}
</script>
</body></html>
"""

SECTION = """<h2>{person} — {n} retrieved, {n_lab} labeled</h2>
<div class="grid">{cards}</div>
"""

CARD = """<div class="card{lab_cls}">
<img src="{src}" loading="lazy" alt="">
<div class="name">{name}</div>
{footer}
</div>
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", default="eval/report.json")
    ap.add_argument("--photos-dir", required=True)
    ap.add_argument("--out", default="eval/review.html")
    args = ap.parse_args()

    with open(args.report, encoding="utf-8") as f:
        report = json.load(f)

    photos_root = os.path.abspath(args.photos_dir)
    sections = []
    for person, pm in report["per_mode"]["face"]["per_person"].items():
        retrieved = pm.get("retrieved")
        if retrieved is None:
            sys.exit("ERROR: report.json has no 'retrieved' lists — rerun eval/run_eval.py first.")
        cards = []
        for r in retrieved:
            pid, labeled = r["photoId"], r["labeled"]
            path = os.path.join(photos_root, pid)
            if not os.path.exists(path):
                footer = '<span style="color:#c00;font-size:11px">file not found</span>'
            elif labeled:
                footer = '<span class="badge">labeled ✓</span>'
            else:
                footer = (
                    f'<label style="font-size:12px"><input type="checkbox" '
                    f'data-photo="{html.escape(pid, quote=True)}" '
                    f'data-person="{html.escape(person, quote=True)}"> is {html.escape(person)}</label>'
                )
            cards.append(CARD.format(
                lab_cls=" labeled" if labeled else "",
                src="file://" + html.escape(path, quote=True),
                name=html.escape(pid),
                footer=footer,
            ))
        n_lab = sum(1 for r in retrieved if r["labeled"])
        sections.append(SECTION.format(
            person=html.escape(person), n=len(retrieved), n_lab=n_lab, cards="".join(cards)
        ))

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(PAGE.format(sections="".join(sections)))
    print(f"Wrote {args.out} — open it in a browser (file:// images need direct open, not a served page).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
