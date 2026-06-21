#!/usr/bin/env python3
"""
make_label_sheet.py — generate a local HTML sheet for hand-labeling the M0
sample (dev plan task 0.3: "hand-label ~10 known attendees").

Writes label_sheet.html INTO the photos directory (image paths are relative,
so it must live there). Open it in a browser, add the people you can
recognize, tick who appears in each photo, then "Download labels.csv" and
save it as matcher/eval/labels.csv.

Tips for a useful eval set:
  - Label every photo each chosen person appears in (missed ones count as
    false positives against the matcher).
  - Pick people with many appearances AND a few with only 2-3.
  - Also collect 1-3 reference photos per person (a clear selfie-style shot,
    NOT from the labeled set if possible) into eval/queries/<person>/.

Usage:
    python eval/make_label_sheet.py ~/event-sample-photos [--people alice,bob]
    # resume later: the sheet can re-import a previously downloaded labels.csv
"""

from __future__ import annotations

import argparse
import json
import os

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
# HEIC won't render in most browsers — warn if found.

TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Find Me — M0 label sheet</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #fafafa; }
  header { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #ddd;
           padding: 10px 16px; z-index: 10; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0 12px 0 0; }
  button { padding: 6px 12px; cursor: pointer; }
  #people-bar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .person-chip { background: #e8f0fe; border-radius: 12px; padding: 2px 10px; font-size: 13px; }
  #grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; padding: 12px; }
  .card { background: #fff; border: 1px solid #ddd; border-radius: 6px; overflow: hidden; }
  .card img { width: 100%; height: 220px; object-fit: cover; display: block; cursor: zoom-in; }
  .card .labels { padding: 6px 8px; font-size: 13px; }
  .card .pid { color: #666; font-size: 11px; padding: 0 8px 6px; word-break: break-all; }
  .card label { display: inline-block; margin-right: 10px; white-space: nowrap; }
  .card.has-labels { border-color: #1a73e8; box-shadow: 0 0 0 1px #1a73e8; }
  #lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 20;
              align-items: center; justify-content: center; }
  #lightbox img { max-width: 95vw; max-height: 95vh; }
  #stats { font-size: 13px; color: #444; }
</style>
</head>
<body>
<header>
  <h1>M0 label sheet</h1>
  <div id="people-bar"></div>
  <button onclick="addPerson()">+ person</button>
  <button onclick="exportCsv()">Download labels.csv</button>
  <input type="file" id="import" accept=".csv" title="Re-import labels.csv to resume">
  <span id="stats"></span>
</header>
<div id="grid"></div>
<div id="lightbox" onclick="this.style.display='none'"><img id="lightbox-img"></div>
<script>
const PHOTOS = __PHOTOS__;
let people = __PEOPLE__;
const labels = {};  // photoId -> Set(person)

function render() {
  const bar = document.getElementById('people-bar');
  bar.innerHTML = people.map(p => `<span class="person-chip">${p}</span>`).join('');
  const grid = document.getElementById('grid');
  grid.innerHTML = PHOTOS.map(pid => {
    const sel = labels[pid] || new Set();
    return `<div class="card ${sel.size ? 'has-labels' : ''}" id="card-${cssId(pid)}">
      <img src="${encodeURI(pid)}" loading="lazy" onclick="zoom('${esc(pid)}')">
      <div class="labels">` +
      people.map(p => `<label><input type="checkbox" ${sel.has(p) ? 'checked' : ''}
        onchange="toggle('${esc(pid)}','${esc(p)}',this.checked)"> ${p}</label>`).join('') +
      `</div><div class="pid">${pid}</div></div>`;
  }).join('');
  updateStats();
}
function cssId(s) { return s.replace(/[^a-zA-Z0-9]/g, '_'); }
function esc(s) { return s.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"); }
function zoom(pid) {
  document.getElementById('lightbox-img').src = encodeURI(pid);
  document.getElementById('lightbox').style.display = 'flex';
}
function toggle(pid, person, on) {
  labels[pid] = labels[pid] || new Set();
  on ? labels[pid].add(person) : labels[pid].delete(person);
  const card = document.getElementById('card-' + cssId(pid));
  card.classList.toggle('has-labels', labels[pid].size > 0);
  updateStats();
}
function addPerson() {
  const name = prompt('Person id (lowercase, no spaces — must match eval/queries/<person>/):');
  if (name && !people.includes(name)) { people.push(name.trim()); render(); }
}
function updateStats() {
  let pairs = 0, photos = 0;
  for (const pid in labels) { if (labels[pid].size) { photos++; pairs += labels[pid].size; } }
  document.getElementById('stats').textContent =
    `${people.length} people · ${photos} labeled photos · ${pairs} (photo,person) pairs`;
}
function exportCsv() {
  let rows = ['photoId,person'];
  for (const pid of PHOTOS) for (const p of (labels[pid] || [])) rows.push(`${pid},${p}`);
  const blob = new Blob([rows.join('\\n') + '\\n'], {type: 'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'labels.csv'; a.click();
}
document.getElementById('import').addEventListener('change', e => {
  const reader = new FileReader();
  reader.onload = () => {
    reader.result.split(/\\r?\\n/).slice(1).forEach(line => {
      if (!line.trim()) return;
      const idx = line.lastIndexOf(',');
      const pid = line.slice(0, idx), person = line.slice(idx + 1).trim();
      if (!people.includes(person)) people.push(person);
      (labels[pid] = labels[pid] || new Set()).add(person);
    });
    render();
  };
  reader.readAsText(e.target.files[0]);
});
render();
</script>
</body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("photos_dir")
    parser.add_argument("--people", default="", help="comma-separated initial person ids")
    args = parser.parse_args()
    root = os.path.expanduser(args.photos_dir)

    photos, heic = [], 0
    for dirpath, _dirs, files in os.walk(root):
        for name in sorted(files):
            ext = os.path.splitext(name)[1].lower()
            rel = os.path.relpath(os.path.join(dirpath, name), root)
            if ext in IMAGE_EXTS:
                photos.append(rel.replace(os.sep, "/"))
            elif ext in (".heic", ".heif"):
                heic += 1
    if not photos:
        print(f"No browser-renderable images in {root}")
        return 1
    if heic:
        print(f"NOTE: {heic} HEIC files skipped (browsers can't render them; "
              "convert to JPG first if you need to label them).")

    people = [p.strip() for p in args.people.split(",") if p.strip()]
    html = TEMPLATE.replace("__PHOTOS__", json.dumps(sorted(photos), ensure_ascii=False)).replace(
        "__PEOPLE__", json.dumps(people, ensure_ascii=False)
    )
    out = os.path.join(root, "label_sheet.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Wrote {out} ({len(photos)} photos). Open it in a browser, label, "
          "then save the downloaded labels.csv as matcher/eval/labels.csv.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
