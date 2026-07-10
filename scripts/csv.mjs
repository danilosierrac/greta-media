/**
 * Writes framer/projects.csv + framer/media.csv from a build manifest,
 * enriched with per-project Client / Description / Credits from
 * scripts/projects-meta.json (edit that file, re-run `node scripts/csv.mjs`).
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RAW_BASE = 'https://raw.githubusercontent.com/danilosierrac/greta-media/main/media';

const csvEscape = (s) => `"${String(s).replace(/"/g, '""')}"`;
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

const clientSlug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function writeCsvs({ campaigns, items }) {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'projects-meta.json'), 'utf8'));
  const titleBySlug = Object.fromEntries(campaigns.map((c) => [c.slug, c.title]));

  // Clients collection — media references it by slug so Framer's tab filters
  // work on Client exactly like they do on the Project reference.
  const clients = [...new Set(Object.values(meta).map((m) => m.client).filter(Boolean))].sort();
  const clientsCsv = ['Title,Slug'];
  for (const c of clients) clientsCsv.push([csvEscape(c), clientSlug(c)].join(','));
  fs.writeFileSync(path.join(ROOT, 'framer', 'clients.csv'), clientsCsv.join('\n') + '\n');

  const projectsCsv = ['Title,Slug,Client,Description,Credits,Order'];
  for (const c of campaigns) {
    if (!items.some((m) => m.campaign === c.slug)) continue;
    const m = meta[c.slug] || {};
    if (!meta[c.slug]) console.log(`⚠️  no meta for ${c.slug} — Client/Description blank`);
    projectsCsv.push([
      csvEscape(c.title), c.slug,
      csvEscape(m.client || ''), csvEscape(m.description || ''), csvEscape(m.credits || ''),
      c.order,
    ].join(','));
  }
  fs.writeFileSync(path.join(ROOT, 'framer', 'projects.csv'), projectsCsv.join('\n') + '\n');

  // Client is denormalized onto every media row (filters can't traverse the
  // Project reference) and holds the client SLUG — a reference into Clients.
  const mediaCsv = ['Title,Slug,Image,Video,alt,Order,Project,Client,Type'];
  for (const m of items) {
    const nn = String(m.order).padStart(2, '0');
    mediaCsv.push([
      csvEscape(`${titleBySlug[m.campaign]} ${nn}`),
      `${m.campaign}-${nn}`,
      `${RAW_BASE}/${encodePath(m.image)}`,
      m.video ? `${RAW_BASE}/${encodePath(m.video)}` : '',
      csvEscape(m.alt),
      m.order,
      m.campaign,
      meta[m.campaign]?.client ? clientSlug(meta[m.campaign].client) : '',
      m.type,
    ].join(','));
  }
  fs.writeFileSync(path.join(ROOT, 'framer', 'media.csv'), mediaCsv.join('\n') + '\n');
  console.log(`${items.length} media rows, ${projectsCsv.length - 1} project rows written`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  writeCsvs(manifest);
}
