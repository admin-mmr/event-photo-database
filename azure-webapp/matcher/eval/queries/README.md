# eval/queries/ — reference photos for the M0 eval

One subfolder per labeled person; the folder name must exactly match the
`person` column in `eval/labels.csv` (lowercase, no spaces):

```
eval/queries/
├── alice/
│   ├── selfie1.jpg      # 1–3 clear, well-lit, front-facing shots
│   └── selfie2.jpg
└── bob/
    └── ref.jpg
```

Guidelines:

- Use selfie-style references — this mimics what attendees will actually
  upload (PRD step 4). Ideally NOT crops from the labeled event photos;
  a different day/outfit gives an honest face-matching number (outfit
  scores will rightly be useless for such references — that's expected,
  the fused sweep accounts for it).
- To also evaluate outfit matching realistically, add one reference taken
  AT the event (same clothing). Run the eval both ways and compare.
- Multiple references per person are averaged into one query embedding.

These photos are biometric data of real people — keep them out of git
(this directory is gitignored except for this README) and delete them
after the M0 report.
