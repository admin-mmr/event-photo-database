#!/usr/bin/env python3
"""
make_frame_review_page.py — contact sheet for judging extracted stills.

Judged the same way the face-matching work is judged (plan §2.3 Phase 0.4):
eyeball it, mark each still keep/reject on the one question that matters —
**would a volunteer have published this as a photo?** — and flag near-duplicates
of an earlier still of the same clip.

    python eval/make_frame_review_page.py --report /tmp/video-spike/report.json \
        --out /tmp/video-spike/review.html
    open /tmp/video-spike/review.html

Selectors sit side by side per clip so the arms are compared on identical
footage, and the page is written INTO the spike output folder so the image
`src`s stay relative (open it straight off disk, no server).

Judgments persist in localStorage as you go; "Download judgments.csv" writes the
file `score_video_frames.py` reads. Judge blind if you can — the selector name
is shown, but score the photo, not the label.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import sys

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Video stills review</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font-family: system-ui, sans-serif; margin: 20px 20px 120px; }}
  h1 {{ margin-bottom: 4px; }}
  .hint {{ color: #666; max-width: 60em; }}
  .clip {{ border-top: 2px solid #8884; margin-top: 28px; padding-top: 8px; }}
  .clipmeta {{ font-size: 13px; color: #777; }}
  .runner {{ font-size: 14px; margin: 8px 0; padding: 6px 10px; display: inline-block;
             border-radius: 6px; background: #f0f0f033; border: 1px solid #8884; }}
  .arm {{ margin: 14px 0 6px; }}
  .arm h3 {{ margin: 0 0 6px; font-size: 15px; }}
  .arm .stats {{ font-size: 12px; color: #777; font-weight: 400; }}
  .grid {{ display: flex; flex-wrap: wrap; gap: 10px; }}
  .card {{ width: 260px; border: 1px solid #8884; border-radius: 8px; padding: 8px; }}
  .card.keep {{ border-color: #2e9e44; background: #2e9e4411; }}
  .card.reject {{ border-color: #c33; background: #c3331a11; }}
  .card img {{ width: 100%; height: 170px; object-fit: cover; border-radius: 4px;
               cursor: zoom-in; background: #0002; }}
  .meta {{ font-size: 11px; color: #777; margin: 5px 0; line-height: 1.45; }}
  .btns {{ display: flex; gap: 6px; align-items: center; }}
  .btns button {{ flex: 1; padding: 5px; font-size: 12px; border-radius: 5px;
                  border: 1px solid #8886; cursor: pointer; background: transparent;
                  color: inherit; }}
  .dupwrap {{ font-size: 11px; color: #777; margin-top: 4px; }}
  .empty {{ font-size: 13px; color: #c33; }}
  #lightbox {{ display: none; position: fixed; inset: 0; background: rgba(0,0,0,.9);
               z-index: 10; cursor: zoom-out; align-items: center; justify-content: center; }}
  #lightbox img {{ max-width: 96vw; max-height: 96vh; object-fit: contain; }}
  #bar {{ position: fixed; bottom: 0; left: 0; right: 0; padding: 10px 16px;
          background: canvas; border-top: 1px solid #8886; display: flex; gap: 12px;
          align-items: center; font-size: 13px; }}
  #bar button {{ padding: 9px 14px; font-size: 13px; border: 0; border-radius: 7px;
                 background: #1a73e8; color: #fff; cursor: pointer; }}
  #bar .ghost {{ background: transparent; color: inherit; border: 1px solid #8886; }}
</style></head><body>
<h1>Would a volunteer have published this photo?</h1>
<p class="hint">Judge each still <b>keep</b> or <b>reject</b> on that question alone —
sharp enough, a runner clearly visible, not obviously a video grab. Tick
<b>near-dup</b> when a still shows essentially the same moment as an earlier kept
still of the same clip. Mark, per clip, whether it contains a clearly visible
runner at all (that is the coverage denominator: a clip with no runner is not
expected to produce anything). Progress is saved in this browser as you go.</p>

{sections}

<div id="lightbox" onclick="this.style.display='none'"><img id="lightbox-img" src=""></div>
<div id="bar">
  <span id="progress"></span>
  <button onclick="downloadCsv()">Download judgments.csv</button>
  <button class="ghost" onclick="if(confirm('Clear all judgments?')){{localStorage.removeItem(KEY);location.reload()}}">Reset</button>
</div>
<script>
const KEY = {storage_key};
const FRAMES = {frames_json};
const CLIPS = {clips_json};
let J = JSON.parse(localStorage.getItem(KEY) || '{{}}');

function save() {{ localStorage.setItem(KEY, JSON.stringify(J)); paint(); }}

function mark(id, verdict) {{
  const cur = J[id] || {{}};
  cur.verdict = (cur.verdict === verdict) ? null : verdict;
  J[id] = cur; save();
}}
function markDup(id, on) {{ J[id] = {{...(J[id] || {{}}), dup: on}}; save(); }}
function markRunner(stem, val) {{ J['clip:' + stem] = {{verdict: val}}; save(); }}

function paint() {{
  FRAMES.forEach(f => {{
    const card = document.getElementById('card-' + f.id);
    if (!card) return;
    const v = (J[f.id] || {{}}).verdict;
    card.classList.toggle('keep', v === 'keep');
    card.classList.toggle('reject', v === 'reject');
    const dup = document.getElementById('dup-' + f.id);
    if (dup) dup.checked = !!(J[f.id] || {{}}).dup;
  }});
  CLIPS.forEach(c => {{
    const v = (J['clip:' + c.stem] || {{}}).verdict;
    const yes = document.getElementById('runner-yes-' + c.stem);
    const no = document.getElementById('runner-no-' + c.stem);
    if (yes) yes.checked = v === 'runner';
    if (no) no.checked = v === 'no_runner';
  }});
  const done = FRAMES.filter(f => (J[f.id] || {{}}).verdict).length;
  const clipsDone = CLIPS.filter(c => (J['clip:' + c.stem] || {{}}).verdict).length;
  document.getElementById('progress').textContent =
    `${{done}}/${{FRAMES.length}} stills judged · ${{clipsDone}}/${{CLIPS.length}} clips marked`;
}}

function downloadCsv() {{
  const rows = ['kind,selector,stem,file,verdict,near_dup'];
  CLIPS.forEach(c => {{
    const v = (J['clip:' + c.stem] || {{}}).verdict;
    if (v) rows.push(['clip', '', c.stem, '', v, ''].join(','));
  }});
  FRAMES.forEach(f => {{
    const j = J[f.id] || {{}};
    if (!j.verdict) return;
    rows.push(['frame', f.selector, f.stem, f.file, j.verdict, j.dup ? '1' : '0'].join(','));
  }});
  const blob = new Blob([rows.join('\\n') + '\\n'], {{type: 'text/csv'}});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'judgments.csv';
  a.click();
}}

document.querySelectorAll('.card img').forEach(img => img.addEventListener('click', () => {{
  document.getElementById('lightbox-img').src = img.src;
  document.getElementById('lightbox').style.display = 'flex';
}}));
document.addEventListener('keydown', e => {{
  if (e.key === 'Escape') document.getElementById('lightbox').style.display = 'none';
}});
paint();
</script>
</body></html>
"""


def face_summary(row: dict) -> str:
    faces = row.get("faces") or []
    if not faces:
        near = row.get("near_miss")
        if near:
            return (f"no publishable face — best was {near['face_px']}px "
                    f"blur {near['blur']:.0f} ({near['dropped']})")
        return "no face detected"
    best = max(faces, key=lambda f: f["face_px"])
    warn = ",".join(best.get("warnings") or [])
    return (f"{len(faces)} face(s), best {best['face_px']}px blur {best['blur']:.0f}"
            + (f" [{warn}]" if warn else ""))


def card(row: dict, selector: str, stem: str) -> str:
    fid = f"{selector}|{stem}|{row['file']}"
    src = f"{selector}/{stem}/{row['file']}"
    meta = (f"t={row['ts']:.2f}s · score {row['score']:.3f}"
            f"{' · I-frame' if row.get('is_iframe') else ''}<br>"
            f"{row.get('width')}×{row.get('height')} · "
            f"{row.get('jpeg_bytes', 0) / 1_000_000:.1f} MB · "
            f"frame blur {row.get('frame_blur', 0):.0f}<br>"
            f"{face_summary(row)} · {row.get('persons', 0)} person box(es)")
    return f"""
      <div class="card" id="card-{html.escape(fid)}">
        <img src="{html.escape(src)}" loading="lazy" alt="">
        <div class="meta">{meta}</div>
        <div class="btns">
          <button onclick="mark('{html.escape(fid)}','keep')">keep</button>
          <button onclick="mark('{html.escape(fid)}','reject')">reject</button>
        </div>
        <label class="dupwrap"><input type="checkbox" id="dup-{html.escape(fid)}"
          onchange="markDup('{html.escape(fid)}', this.checked)"> near-dup of an earlier keep</label>
      </div>"""


def build(report: dict) -> tuple[str, list[dict], list[dict]]:
    by_clip: dict[str, list[dict]] = {}
    for r in report.get("results", []):
        by_clip.setdefault(r["stem"], []).append(r)

    frames_meta: list[dict] = []
    clips_meta: list[dict] = []
    sections: list[str] = []

    for stem, arms in by_clip.items():
        v = arms[0]["video"]
        clips_meta.append({"stem": stem})
        notes = ", ".join(arms[0].get("notes") or [])
        head = (f'<div class="clip"><h2>{html.escape(arms[0]["clip"])}</h2>'
                f'<div class="clipmeta">{v["display_width"]}×{v["display_height"]} · '
                f'{v["duration_s"]:.1f}s · {v["fps"]:.0f}fps · {html.escape(v["codec"])}'
                f'{" · " + html.escape(notes) if notes else ""} · budget K={arms[0]["budget"]}</div>'
                f'<div class="runner">This clip shows a clearly visible runner: '
                f'<label><input type="radio" name="runner-{html.escape(stem)}" '
                f'id="runner-yes-{html.escape(stem)}" '
                f"onchange=\"markRunner('{html.escape(stem)}','runner')\"> yes</label> "
                f'<label><input type="radio" name="runner-{html.escape(stem)}" '
                f'id="runner-no-{html.escape(stem)}" '
                f"onchange=\"markRunner('{html.escape(stem)}','no_runner')\"> no</label></div>")
        body = []
        for arm in sorted(arms, key=lambda a: a["selector"]):
            cards = []
            for row in arm.get("accepted", []):
                frames_meta.append({"id": f"{arm['selector']}|{stem}|{row['file']}",
                                    "selector": arm["selector"], "stem": stem,
                                    "file": row["file"]})
                cards.append(card(row, arm["selector"], stem))
            stats = (f'scan {arm["scanned"]} → gate {arm["gated"]} → short {arm["shortlisted"]}'
                     f' → kept {arm["accepted_count"]} · {arm["cost"]["cpu_s"]:.1f} cpu-s'
                     f' ({arm["cost"]["cpu_s_per_video_s"]:.2f} per video-s)')
            inner = "".join(cards) if cards else (
                '<p class="empty">nothing accepted — check the rejected/ folder and the '
                'reasons in report.json</p>')
            body.append(f'<div class="arm"><h3>{html.escape(arm["selector"])} '
                        f'<span class="stats">{stats}</span></h3>'
                        f'<div class="grid">{inner}</div></div>')
        sections.append(head + "".join(body) + "</div>")

    return "".join(sections), frames_meta, clips_meta


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--report", required=True, help="report.json from run_video_spike.py")
    ap.add_argument("--out", help="output html (default: review.html beside the report)")
    a = ap.parse_args()

    report_path = os.path.expanduser(a.report)
    with open(report_path) as fh:
        report = json.load(fh)

    out = os.path.expanduser(a.out) if a.out else os.path.join(
        os.path.dirname(os.path.abspath(report_path)), "review.html")
    if os.path.dirname(os.path.abspath(out)) != os.path.dirname(os.path.abspath(report_path)):
        print("WARNING: writing the page outside the spike folder breaks the relative "
              "image paths — the stills will not load.", file=sys.stderr)

    sections, frames, clips = build(report)
    if not frames:
        print("no accepted stills in the report — nothing to judge", file=sys.stderr)
    html_out = PAGE.format(
        sections=sections,
        frames_json=json.dumps(frames),
        clips_json=json.dumps(clips),
        storage_key=json.dumps("video-spike:" + os.path.basename(
            os.path.dirname(os.path.abspath(report_path)))),
    )
    with open(out, "w") as fh:
        fh.write(html_out)
    print(f"{out}  ({len(frames)} stills across {len(clips)} clips)")
    print("Open it, judge, then click 'Download judgments.csv' and save it beside report.json.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
