# greta-media

Staging repo for **Greta's portfolio → Framer CMS** media pipeline (Zalando campaigns).

Source of truth: Greta's curated selection on Google Drive
(`Shared drives/mimosa GmbH/Accounts and Projects/Greta's portfolio/Zalando `— note the trailing space).

## What's here

- `media/<campaign-slug>/NN.jpg` — web-optimized images (max 2000px long edge, progressive JPEG q80, all well under the 5MB Framer plan cap)
- `media/<campaign-slug>/NN.mp4` + `NN-poster.jpg` — compressed videos (H.264, 1080p max, faststart) with poster frames
- `framer/projects.csv` — the campaigns collection (import FIRST): `Title,Slug,Client,Description,Credits,Order`. `Description` = one micro-blurb per project (shown in the lightbox via the reference); `Credits` = markdown for a Formatted Text field (Hogan filled, rest empty). Drafted copy — Greta approves/edits in the CMS.
- `framer/media.csv` — the media collection: `Title,Slug,Image,Video,alt,Order,Project,Client,Type`. `Project` references campaigns by slug. `Client` is denormalized from the project (auto-filled by `scripts/csv.mjs` from `scripts/projects-meta.json`) because Framer's native filters can't reach through references — this powers the clickable brand filter.
- Edit per-project copy in `scripts/projects-meta.json`, then `node scripts/csv.mjs` to regenerate both CSVs from `manifest.json` (no media reprocessing).
- `manifest.json` — full build record incl. source paths and failures
- `scripts/build.mjs` — the pipeline; incremental, safe to re-run (`node scripts/build.mjs`)

## Import order & rules

1. Import `framer/projects.csv` into the Projects/Campaigns collection.
2. Import `framer/media.csv` into the media collection — map `Image` (image field), `Video` (link field), `Project` (reference, matched by slug).
3. Framer **rehosts images** to framerusercontent.com during import → this repo is a loading dock for images.
4. Video links are **NOT rehosted** — the raw GitHub URLs must stay alive (or be swapped to R2/Bunny/native upload after the plan upgrade).
5. **Never re-import old rows.** Framer matches by slug and overwrites, destroying CMS edits. Future syncs = delta CSVs with new slugs only.

## Known source quirks

- Folder `09 - Asics Gel-Quantum 360 AMP` and `20- 66 North` were empty at build time.
- Two folders share prefix `11` (194. Drip / Adidas Culture Wear); `14` is missing.
