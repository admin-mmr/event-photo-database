# EVAL_FEEDBACK_LOOP.md — continuous accuracy measurement after beta launch

**Status:** designed 2026-06-11 (M0 decision: label-as-we-go instead of exhaustive pre-launch labeling). Builds on the PRD's `match_feedback` collection (§FR-15…17) and the dev plan M4 task 4.4. This doc defines how user feedback becomes eval labels, what metrics replace the M0 hand-labeled eval, and the guardrails.

## 1. Why

M0 shipped with a 2-person spot-labeled eval. That proves the pipeline works but is too small to tune fusion weights or gate new events. Instead of hand-labeling ~10 attendees per event up front, beta users label for us: every "Confirmed" / "Not me" tap is a ground-truth (photo, person) pair from exactly the population and photo conditions we care about.

## 2. Label sources (strongest → weakest)

| Source | Label | Trust |
|---|---|---|
| `match_feedback.label = confirmed` | positive (photoId, userId) | High — explicit |
| `match_feedback.label = wrong` | hard negative | High — explicit |
| Photo downloaded/saved to Drive from results | weak positive | Medium — implicit; count separately, never mix into judged precision |
| Admin spot audit (`matcher/eval/make_review_page.py` against a user's actual query) | positive/negative | High — use for recall checks and disputes |

The query side of each pair is the user's actual Find Me upload: `match_runs` already stores `uploadId` + which signal/scores produced each result, so the eval replays real queries — no synthetic selfies needed.

## 3. The key semantics change: judged precision

The M0 harness (`eval/run_eval.py`) assumes **exhaustive** labels: anything retrieved-but-unlabeled counts as a false positive. Feedback labels are inherently **partial** — users judge only what they're shown, and not all of it. So beta metrics must only score judged pairs:

- **Judged P@20** = confirmed / (confirmed + wrong) among top-20 results that received feedback. Unjudged results are *excluded*, not counted as negatives.
- **Recall is unmeasurable from feedback** (users never see what the matcher missed). Track proxies instead: zero-confirmed-search rate, "show more" usage, and run periodic admin spot audits (review page over the full event) on 1–2 events per quarter for a true recall number.
- Per PRD §2 the target stays **judged P@20 ≥ 0.85 per event**, with a minimum evidence bar before the number is considered meaningful: **≥ 20 judged pairs from ≥ 5 distinct users** per event.

## 4. Pipeline

```
Results UI (M4)                    weekly job / manual script
"Confirmed" / "Not me" ──► Firestore match_feedback
                                   │
                                   ▼
                        eval/export_feedback_labels.py   (NEW, M4)
                        → per-event judged-labels CSV
                        (photoId, person=userId, label, signal, model_version)
                                   │
                                   ▼
                        eval/run_eval.py --judged-only    (NEW flag, M4)
                        replays match_runs queries, scores judged pairs
                                   │
                                   ▼
                        report.json per (event, model_version, fusion weights)
                                   │
                ┌──────────────────┼──────────────────────┐
                ▼                  ▼                      ▼
        weekly review      fusion-weight tuning     release gate
        (admin queue,      (offline sweep on        (new event / new
        FP-rate trend)     accumulated labels,      model_version must
                           human approves config    pass judged P@20
                           change — never auto)     before enablement)
```

Build items (slot into M4 alongside task 4.4, ~2–3 days total):

1. `eval/export_feedback_labels.py` — Firestore → labels CSV per event.
2. `run_eval.py --judged-only` — skip the unlabeled-as-negative assumption; replay stored query embeddings from `match_runs` instead of `eval/queries/`.
3. Admin metrics rollup (extends the M4 feedback admin queue): judged P@20, FP rate, confirm rate, feedback participation rate, per event × model_version, trended weekly.

## 4b. "Too few photos — see more" expander (decided 2026-06-11)

The results page shows only results above the conservative default cutoff. A **"Too few photos? See more"** button relaxes the cutoff **one bounded step** (fixed second threshold or next 20, whichever is smaller) and appends **only the diff**. The user can then tag photos to keep them — tagging adds the photo to their results/download set **and** writes a row to `match_feedback`.

**Tag-reason dropdown.** Each tag carries a reason — **Me** (default) / **Friend** / **Group photo** — stored as `tagReason` on the `match_feedback` row (the PRD schema's `reason?` field, now structured). One tap keeps the default "Me"; the dropdown is there to *keep wrong labels out*, not to add friction. Eval semantics per reason:

| `tagReason` | User gets photo | Eval label for the searcher |
|---|---|---|
| `me` (default) | yes | `confirmed` positive |
| `friend` | yes | **excluded** — it's a positive for someone else, identity unknown |
| `group` | yes | **excluded** from judged precision; count separately — high group-tag volume on face-mode results may mean the user *is* in them but uncertain, worth spot-auditing |

This replaces the "noise" caveat below with a structural fix: friend/group tags no longer pollute judged precision at all, and "Me" tags become trustworthy enough that the human reviewing threshold changes (§5) works from clean data.

Semantics and instrumentation:

- Tags in the expanded band are the highest-value labels for threshold tuning — they sit at the decision boundary. Record the band (`tier: default | expanded`) on `match_runs` results and `match_feedback` rows so eval can score bands separately.
- **Untagged expanded photos are unjudged, not negatives** (user may have stopped scrolling). Only explicit "Not me" is a negative — same judged-precision rule as §3.
- **Expander click rate per event is the recall proxy**: high click rate ⇒ default cutoff too strict; many confirmed tags in the expanded band ⇒ quantified case for lowering it.
- **Privacy bound:** every relaxation shows the searcher more photos of other attendees. Exactly one expansion step, no unbounded loosening; expansion stays event-scoped and consent-gated like the default results.
- **Noise:** largely handled by the tag-reason dropdown above — only `me` tags enter judged precision. Residual risk (users leaving "Me" selected carelessly) is covered by human review before config changes (§5) and spot audits.

## 5. Guardrails

- **Feedback bias.** Users only judge the top-20 shown — feedback can never reveal recall problems or rank-21+ misses. Hence the quarterly spot audits and the zero-confirmed-rate proxy. Don't let a good judged-precision number imply "matching is solved."
- **Volume thresholds.** Below 20 judged pairs / 5 users, show the number greyed-out; never gate or tune on it.
- **Human in the loop.** Fusion weights and thresholds are config (PRD §7.2) — changes are proposed by the offline sweep, reviewed by a human, and verified against the *full* accumulated label set before prod config changes. No automatic tuning.
- **Precision-favoring UX while data accumulates.** Per PRD risk table: conservative threshold + "show more" expander, so early FPs are opt-in rather than default.
- **Privacy & retention.** Feedback rows reference `photoId`/`uploadId`/`userId`; the retention cascade (PRD §FR-deletion) must also delete derived eval labels and stored query embeddings when a user deletes their data. Exported label CSVs are derived biometric-adjacent data: keep in GCS under the same retention rules, never in git (mirror the `eval/queries/` gitignore approach).
- **Model upgrades.** Labels are (photo, person) pairs — they survive `model_version` bumps. Re-run the judged eval per version to catch regressions (dev plan §test-strategy already requires this).

## 6. Launch sequence

1. **Beta launch (post-M4):** ship with M0-chosen fusion weights (face-heavy; outfit weight only matters for same-day references). Feedback UI live from day one — it's the data collection mechanism, not an afterthought.
2. **Weeks 1–4:** weekly eval review; expect noisy numbers until volume thresholds are met. Tune nothing in week 1.
3. **Once a 2nd event meets the evidence bar:** run the fusion sweep on real labels → lock weights → this satisfies the M2 DoD gate ("P@20 ≥ 0.85 on 2 events") with judged precision.
4. **Steady state:** weekly rollup glance, quarterly spot audit, gate every new event/model on the judged eval.
