/**
 * greta-media build pipeline
 *
 * Walks Greta's curated Zalando selection on Google Drive, optimizes every
 * asset for web, and emits Framer-importable CSVs.
 *
 * - Images: sharp → max 2000px long edge, progressive JPEG q80 (re-tried at
 *   q68 if the result somehow exceeds 4.5MB — Framer plan cap is 5MB).
 * - Videos: ffmpeg → H.264 1080p-max CRF 26 + faststart, plus a poster JPEG
 *   grabbed at 40% duration (gallery components are image-only).
 * - Incremental: outputs that already exist are skipped, so re-runs are cheap
 *   and a crashed run can simply be restarted.
 * - Dedupe: md5 of source bytes; later copies of an already-seen file are
 *   dropped (Drive folders contain "Final Assets" subfolder near-dupes).
 *
 * Usage: node scripts/build.mjs [--csv-only]
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const SRC = "/Users/danilosierra/Library/CloudStorage/GoogleDrive-danilo@mimosaagency.com/Shared drives/mimosa GmbH/Accounts and Projects/Greta's portfolio/Zalando ";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'media');
const RAW_BASE = 'https://raw.githubusercontent.com/danilosierrac/greta-media/main/media';

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png']);
const VID_EXT = new Set(['.mp4', '.mov']);
const MAX_EDGE = 2000;
const CSV_ONLY = process.argv.includes('--csv-only');

// ---------- campaign folders ----------

function cleanTitle(name) {
  return name
    .replace(/^\d+\s*-\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(s) {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const campaigns = fs.readdirSync(SRC, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const order = parseInt(d.name, 10) || 999;
    const title = cleanTitle(d.name);
    return { dir: path.join(SRC, d.name), folder: d.name, order, title, slug: slugify(title) };
  })
  .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

// ---------- walk files ----------

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function md5(file) {
  return createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function ffprobeDuration(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    return parseFloat(out) || 0;
  } catch { return 0; }
}

// Human-ish alt text from the original filename.
function altFrom(filename) {
  return path.basename(filename, path.extname(filename))
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- process ----------

const manifest = [];
const failures = [];
const seen = new Set();

for (const c of campaigns) {
  // Drive folders get renamed/synced while we run (e.g. "05-" → "05 - ");
  // a vanished dir must not kill the whole build.
  let files;
  try {
    files = walk(c.dir);
  } catch (err) {
    failures.push({ file: c.dir, error: String(err.message || err).slice(0, 200) });
    console.log(`❌ campaign inaccessible, skipped: ${c.folder}`);
    continue;
  }
  files = files.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return IMG_EXT.has(ext) || VID_EXT.has(ext);
  }).sort();

  if (!files.length) { console.log(`⚠️  ${c.folder} — empty, skipped`); continue; }

  const destDir = path.join(OUT, c.slug);
  fs.mkdirSync(destDir, { recursive: true });

  let n = 0;
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const isVideo = VID_EXT.has(ext);
    try {
      const hash = md5(f); // reads bytes → triggers Drive download
      if (seen.has(hash)) { console.log(`   dup, skipped: ${path.basename(f)}`); continue; }
      seen.add(hash);
      n += 1;
      const nn = String(n).padStart(2, '0');

      if (isVideo) {
        const outVid = path.join(destDir, `${nn}.mp4`);
        const outPoster = path.join(destDir, `${nn}-poster.jpg`);
        if (!CSV_ONLY && !fs.existsSync(outVid)) {
          execFileSync('ffmpeg', [
            '-y', '-i', f,
            '-vf', "scale='min(1920,iw)':-2",
            '-c:v', 'libx264', '-crf', '26', '-preset', 'veryfast',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
            '-c:a', 'aac', '-b:a', '128k',
            outVid,
          ], { stdio: ['ignore', 'ignore', 'pipe'] });
        }
        if (!CSV_ONLY && !fs.existsSync(outPoster)) {
          const dur = ffprobeDuration(outVid);
          execFileSync('ffmpeg', ['-y', '-ss', String((dur * 0.4).toFixed(2)), '-i', outVid, '-frames:v', '1', '-q:v', '3', outPoster], { stdio: ['ignore', 'ignore', 'pipe'] });
        }
        manifest.push({
          campaign: c.slug, type: 'Video', order: n,
          image: `${c.slug}/${nn}-poster.jpg`, video: `${c.slug}/${nn}.mp4`,
          alt: altFrom(f), source: f,
        });
      } else {
        const outImg = path.join(destDir, `${nn}.jpg`);
        if (!CSV_ONLY && !fs.existsSync(outImg)) {
          const enc = (q) => sharp(f)
            .rotate()
            .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: q, progressive: true, mozjpeg: true })
            .toFile(outImg);
          await enc(80);
          if (fs.statSync(outImg).size > 4.5 * 1024 * 1024) await enc(68);
        }
        manifest.push({
          campaign: c.slug, type: 'Image', order: n,
          image: `${c.slug}/${nn}.jpg`, video: '',
          alt: altFrom(f), source: f,
        });
      }
      process.stdout.write(`   ${c.slug}/${nn} ${isVideo ? '🎞' : '🖼'} ${path.basename(f)}\n`);
    } catch (err) {
      failures.push({ file: f, error: String(err.message || err).slice(0, 200) });
      console.log(`   ❌ FAILED: ${path.basename(f)}`);
    }
  }
  console.log(`✅ ${c.slug}: ${n} items`);
}

// ---------- CSVs ----------

const csvEscape = (s) => `"${String(s).replace(/"/g, '""')}"`;
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

const titleBySlug = Object.fromEntries(campaigns.map((c) => [c.slug, c.title]));

const projectsCsv = ['Title,Slug,Client,Order'];
for (const c of campaigns) {
  if (!manifest.some((m) => m.campaign === c.slug)) continue;
  projectsCsv.push([csvEscape(c.title), c.slug, 'Zalando', c.order].join(','));
}
fs.writeFileSync(path.join(ROOT, 'framer', 'projects.csv'), projectsCsv.join('\n') + '\n');

const mediaCsv = ['Title,Slug,Image,Video,alt,Order,Project,Type'];
for (const m of manifest) {
  const nn = String(m.order).padStart(2, '0');
  mediaCsv.push([
    csvEscape(`${titleBySlug[m.campaign]} ${nn}`),
    `${m.campaign}-${nn}`,
    `${RAW_BASE}/${encodePath(m.image)}`,
    m.video ? `${RAW_BASE}/${encodePath(m.video)}` : '',
    csvEscape(m.alt),
    m.order,
    m.campaign,
    m.type,
  ].join(','));
}
fs.writeFileSync(path.join(ROOT, 'framer', 'media.csv'), mediaCsv.join('\n') + '\n');
fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify({ campaigns, items: manifest, failures }, null, 2));

console.log(`\n${manifest.length} items → framer/media.csv · ${projectsCsv.length - 1} projects → framer/projects.csv`);
if (failures.length) console.log(`⚠️  ${failures.length} failures — see manifest.json`);
