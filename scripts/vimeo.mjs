/**
 * Vimeo migration for the 58 campaign videos.
 *
 * Pull-uploads each staged video from its public GitHub raw URL (server-to-
 * server, nothing leaves this machine), waits for transcode, then records the
 * best progressive .mp4 file link. State lives in scripts/vimeo-map.json —
 * re-runs skip already-uploaded slugs, so it's safe to interrupt.
 *
 * Usage:
 *   node scripts/vimeo.mjs --limit 1   # test run (first video only)
 *   node scripts/vimeo.mjs             # everything
 * After: node scripts/csv.mjs          # media.csv picks up the Vimeo links
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RAW_BASE = 'https://raw.githubusercontent.com/danilosierrac/greta-media/main/media';
const MAP_PATH = path.join(ROOT, 'scripts', 'vimeo-map.json');

const TOKEN = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/VIMEO_TOKEN=(\S+)/)?.[1];
if (!TOKEN) { console.error('no VIMEO_TOKEN in .env'); process.exit(1); }

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

const api = async (method, url, body) => {
  const res = await fetch(url.startsWith('http') ? url : `https://api.vimeo.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.vimeo.*+json;version=3.4',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${json.error || json.developer_message || ''}`);
  return json;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const titleBySlug = Object.fromEntries(manifest.campaigns.map((c) => [c.slug, c.title]));
const videos = manifest.items.filter((m) => m.video).map((m) => ({
  slug: `${m.campaign}-${String(m.order).padStart(2, '0')}`,
  name: `${titleBySlug[m.campaign]} ${String(m.order).padStart(2, '0')}`,
  url: `${RAW_BASE}/${m.video.split('/').map(encodeURIComponent).join('/')}`,
}));

const map = fs.existsSync(MAP_PATH) ? JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')) : {};
const save = () => fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2));

// ---- phase A: create pull uploads ----
let started = 0;
for (const v of videos) {
  if (map[v.slug]?.uri) continue;
  if (started >= LIMIT) break;
  try {
    const created = await api('POST', '/me/videos', {
      upload: { approach: 'pull', link: v.url },
      name: v.name,
      privacy: { view: 'unlisted', embed: 'public' },
    });
    map[v.slug] = { uri: created.uri, link: created.link };
    started += 1;
    console.log(`⬆️  pull started: ${v.slug} → ${created.uri}`);
    save();
    await sleep(600); // stay friendly with the rate limit
  } catch (err) {
    if (String(err).includes('privacy')) {
      // unlisted not available → fall back to public
      const created = await api('POST', '/me/videos', {
        upload: { approach: 'pull', link: v.url },
        name: v.name,
        privacy: { view: 'anybody' },
      });
      map[v.slug] = { uri: created.uri, link: created.link };
      started += 1;
      console.log(`⬆️  pull started (public): ${v.slug} → ${created.uri}`);
      save();
    } else {
      console.log(`❌ pull failed: ${v.slug} — ${err.message}`);
    }
  }
}

// ---- phase B: poll for transcode + collect file links ----
const pending = () => Object.entries(map).filter(([, v]) => v.uri && !v.fileLink);
let rounds = 0;
while (pending().length && rounds < 240) {
  rounds += 1;
  for (const [slug, v] of pending()) {
    try {
      const d = await api('GET', `${v.uri}?fields=transcode.status,files,upload.status`);
      if (d.upload?.status === 'error') { console.log(`❌ upload error: ${slug}`); v.error = 'upload_error'; v.fileLink = 'ERROR'; save(); continue; }
      if (d.transcode?.status !== 'complete') continue;
      const mp4s = (d.files || []).filter((f) => f.quality !== 'hls' && f.link);
      if (!mp4s.length) { console.log(`⚠️  ${slug}: transcoded but NO files[] — plan may not expose file links`); v.fileLink = 'UNAVAILABLE'; save(); continue; }
      const best = mp4s.sort((a, b) => (b.width || 0) - (a.width || 0)).find((f) => (f.width || 0) <= 1920) || mp4s[0];
      v.fileLink = best.link;
      v.rendition = best.rendition || `${best.width}x${best.height}`;
      console.log(`✅ ${slug}: ${v.rendition} file link captured`);
      save();
    } catch (err) {
      console.log(`   poll ${slug}: ${err.message}`);
    }
    await sleep(400);
  }
  if (pending().length) { console.log(`   … ${pending().length} still transcoding`); await sleep(15000); }
}

const done = Object.values(map).filter((v) => v.fileLink && !['ERROR', 'UNAVAILABLE'].includes(v.fileLink)).length;
console.log(`\n${done}/${videos.length} Vimeo file links in scripts/vimeo-map.json`);
