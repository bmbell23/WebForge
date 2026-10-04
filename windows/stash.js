// #177: "Add to Stash" — the request body and the job-status wording.
//
// The Dashboard does the downloading and the Stash tagging (Dashboard#68,
// agent-bus thread 021): POST /api/download/stash answers with a job id at
// once, GET /api/download/stash/<job> reports queued → downloading → scanning
// → tagging → done | failed. What the page tells us comes from
// shared/stash-page.js, the same reader the phone runs. No Electron here.
'use strict';

const fs = require('fs');
const path = require('path');
const ytdlp = require('./ytdlp');

const ENDPOINT = (() => {
  try { return new URL('/api/download/stash', ytdlp.ENDPOINT).href; } catch { return ''; }
})();

// Repo layout in dev, beside main.js once packaged (package.json copies shared/).
function readerSource() {
  for (const p of [
    path.join(__dirname, '..', 'shared', 'stash-page.js'),
    path.join(process.resourcesPath || '', 'shared', 'stash-page.js'),
    path.join(__dirname, 'shared', 'stash-page.js'),
  ]) {
    try { return fs.readFileSync(p, 'utf8'); } catch { /* next */ }
  }
  return '';
}

const KINDS = ['media', 'video', 'gallery'];

const canSend = (url) => ytdlp.downloadable(url);

/** A gallery is worth offering once the page links a few full-size images. */
const GALLERY_MIN = 3;
const isGallery = (meta) => ((meta && meta.image_urls) || []).length >= GALLERY_MIN;

/** The POST body. `meta` is the reader's output (or {} when it couldn't run). */
function body(kind, url, pageUrl, meta = {}) {
  if (!KINDS.includes(kind) || !canSend(url)) return null;
  const m = meta || {};
  const page = canSend(pageUrl) ? pageUrl : url;
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
  const out = {
    kind,
    url,
    page_url: page,
    meta: {
      title: m.title || null,
      performers: list(m.performers),
      studio: m.studio || null,
      site: m.site || ytdlp.hostOf(page) || null,
      date: /^\d{4}-\d{2}-\d{2}$/.test(m.date || '') ? m.date : null,
      tags: list(m.tags),
    },
  };
  // Only a gallery carries the image list; the server falls back to it when gallery-dl can't read the site.
  if (kind === 'gallery') out.meta.image_urls = list(m.image_urls).filter(canSend);
  return out;
}

const LABEL = { media: 'file', video: 'video', gallery: 'gallery' };

/** One line for the ⤓ button tooltip / notification, from a status reply. */
function statusText(kind, s) {
  const what = LABEL[kind] || 'item';
  if (!s || !s.state) return `Stash: waiting for the ${what}…`;
  switch (s.state) {
    case 'queued': return `Stash: ${what} queued`;
    case 'downloading': return `Stash: downloading ${what}…`;
    case 'scanning': return `Stash: scanning ${what}…`;
    case 'tagging': return `Stash: tagging ${what}…`;
    case 'done': return `Added ${what} to Stash${s.path ? `: ${String(s.path).split('/').pop()}` : ''}`;
    case 'failed': return `Stash ${what} failed: ${String(s.error || 'unknown error').slice(0, 300)}`;
    default: return `Stash: ${s.state}`;
  }
}

const finished = (s) => !!s && (s.state === 'done' || s.state === 'failed');

module.exports = { ENDPOINT, KINDS, GALLERY_MIN, readerSource, canSend, isGallery, body, statusText, finished };
