# Find-Me selfie-quality work — handoff

Session of 2026-08-02 → 2026-08-06. Everything below is merged unless marked
otherwise. Written for whoever picks this up next, including a future me.

## The one thing that needs a decision

**`audit-person-crops.sh` currently FAILS: 8 of 10 indexed events have person
("outfit") embeddings that were built WITHOUT the detector, and the matcher now
queries WITH it.** Nothing is visibly broken; the outfit half of every fused
search on those events is quietly comparing mismatched geometry.

```
./cloud-webapp/infra/scripts/audit-person-crops.sh mmr-data-pipeline   # exits 1
```

| event | photos | geometry |
|---|--------|----------|
| `81a584f7` | 3,408 | face-expand — tag lies *(the judged P@20 baseline event)* |
| `ecd530b9` | 3,318 | face-expand — tag lies |
| `34f3e38f` | 854 | face-expand — tag lies |
| `d2307147` | 795 | face-expand — tag lies |
| `aae4e121` | 468 | face-expand — tag lies |
| `2622d5ab` | 417 | face-expand — tag lies |
| `0447feba` / `c1ac19ba` | 9 | face-expand — tag lies |
| `5ff5ff5c` | 6,914 | OK — real detections |
| `bb425a27` | 553 | OK — real detections |

`yolov8n.onnx` was staged 2026-08-02 15:09 UTC and is baked into the running
matcher. The two clean events were indexed after that; the rest predate it.

**Why the nightly index runs did not fix it, and will never fix it.**
`indexer/job.py`:

```python
if prev and prev["manifest"].get("modelVersion") == model_version:
    prev_rows = ...   # reuse — no re-embed
```

The stale manifests already claim `…+yolov8n+…@m1` — the old hardcoded constant
that lied. Now that the detector genuinely loads, the derived version is the
*same string*, so the check matches and the rows are reused forever. The lying
tag actively defeats the self-heal. Only `FORCE_REINDEX=1` (which sets
`cfg.force`, making `prev = None`) will re-embed them.

**Cost of the fix:** 9,269 photos across 8 events. At CLAUDE.md's measured rate
(~1,134 photos ≈ 9,600 vCPU-s) that is ~78k vCPU-seconds, roughly a third of the
monthly free allowance. Note the allowance is ONE ~240k vCPU-s pool shared
across services *and* jobs — CLAUDE.md's claim that jobs get a separate tier is
wrong — and CPU, not memory, is the binding constraint.

**Suggested approach:** force-reindex `2622d5ab` (417 photos) first, re-run the
audit to confirm it flips to `detections`, then decide about the rest.
Afterwards, outfit-tagger events need re-preparing — they key on
`sourceModelVersion`.

## What shipped

Find-Me's pick → search → judge flow, in the order a user meets it.

| PR | what |
|----|------|
| #52 | anchor promotion, per-face quality, the `/quality` pick-time check |
| #56 | multi-face selfie is a **hard reject**; `/quality` returns `faceBox` |
| #67 | reframe a badly-framed selfie; the crop becomes the uploaded photo |
| #68 | bulk "all me" / "all not me", scoped to the page on screen |
| #69 | weak-selfie score nudge; support prompt + ops alert after 3 rejections |
| #70 | ask about unjudged results before turning the page |
| #54 | azure-webapp re-aligned to the unified vocabulary |

Design decisions worth not re-litigating:

- **The multi-face stop is scoped to `/quality`, never `assess_face`.** That
  function is shared with the indexer, where a photo full of faces is the normal
  case. There is a test pinning the boundary; breaking it would make most event
  photos unindexable.
- **The suggested crop is not a face crop.** Fused mode queries on the face
  embedding *and* a person/outfit crop from the same image, so a tight head shot
  would hand the matcher a photo with no body and destroy the outfit half of the
  query. `suggestedPortraitRect` keeps head + shoulders + torso.
- **Bulk verdicts never leave the page on screen.** The batch cap and the largest
  page size are both 200, so requests are bounded by construction.
- **"Rest aren't me" is an opt-in checkbox, not a peer button.** People download
  in batches; an unticked photo usually means "not this batch", not "not me".
  The ticks are evidence, their absence is not.
- **The uploaded crop carries no EXIF.** Orientation is baked in before drawing,
  but `DateTimeOriginal` is lost, so a cropped selfie cannot anchor
  capture-time-conditional fusion. That knob is off by default; if
  `FUSION_TIME_CONDITIONAL` is ever switched on, read the anchor from the
  original file *before* cropping.

## Deploy state

- **matcher** — redeployed 2026-08-05 from `f31e530`, revision
  `matcher-00026-tt6`, image `20260805-230822`. Verified after: `api-runtime@`
  still holds `run.invoker` (a redeploy can silently strip it), and min-instances
  is still unset so it scales to zero. No matcher changes in main since.
- **web / api** — deployed by CI. Most of the recent work is web-side, so if the
  UX looks stale, check the web deploy rather than the matcher.
- I could not smoke-test the matcher over HTTP: it is private and a user account
  cannot mint a service-scoped token, so `gcloud run services proxy` returns a
  Google Front End 404. That is not a failure. `Ready=True` is the health signal.

## Provisional values that want a judged sweep

Both are mine, both flagged in code, neither backed by data:

- `WEAK_SELFIE_SCORE = 0.65` (shared/schemas/findme.ts) — set just above a worked
  example (frontality 0.56, 11% of frame, just-sharp ≈ 0.61), not swept. Advisory
  only: it changes what we *say*, never whether a search runs.
- `REJECTS_BEFORE_HELP = 3` (web/pages/FindMe.tsx).

`FACE_QUALITY_WEIGHT` is still 0.0 and waiting on the same sweep
(`run_eval.py --judged-only --anchor-promotion --face-quality-weight …`).

## Loose ends

- **Single-page result sets never see the page-turn checkpoint** — there is no
  page turn to intercept, and that is the common case for a small event. Hanging
  the same prompt off leaving the results is a different trigger; do it
  deliberately.
- **Random-sample annotation** was proposed and I argued against it: it serves
  the eval loop rather than the user, and unmotivated labels are careless ones.
  An admin-side sampling queue would get better labels.
- **`selfie_stuck` alerts reuse the crash channel**, so they log at ERROR and
  also match the general error policy.
  `infra/monitoring/selfie-stuck-alert-policy.json` filters
  `kind="selfie_stuck"` for separate routing — apply it if the noise matters.

## Two process traps hit this session

- **PR #58 was merged and then vanished from main.** Its merge commit was not an
  ancestor of `origin/main` while #56/#57 (same minute) and #59 onward were —
  main had been reset to #57 and work continued. Restored via cherry-pick in #67.
  Worth knowing the failure mode exists: a green PR page is not proof the code is
  in main. `git merge-base --is-ancestor <merge-sha> origin/main` is.
- **A stale zero-byte `.git/HEAD.lock` from a crashed operation** silently blocked
  every HEAD update in the root checkout for a day — `git switch` failed while
  the index already matched `origin/main`. Check `ls .git/*.lock` when git starts
  refusing to move HEAD.
