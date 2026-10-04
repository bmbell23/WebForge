// #156: send the current page to the Dashboard's yt-dlp.
//
// The Dashboard already does the hard part: POST {url, format, adult, short,
// kids} to /api/download/ytdlp and it picks the folder (music, kid-media,
// other/Videos/Full + a Stash scan, ...). All WebForge decides is the body, and
// that decision has to match the phone exactly, so it lives here with no
// Electron in it and is pinned by shared/ytdlp-fixtures.tsv, which the Android
// test reads too.
'use strict';

const fs = require('fs');
const path = require('path');

// Repo layout in dev, beside main.js once packaged (package.json copies shared/).
function loadSites() {
  for (const p of [
    path.join(__dirname, '..', 'shared', 'ytdlp-sites.json'),
    path.join(process.resourcesPath || '', 'shared', 'ytdlp-sites.json'),
    path.join(__dirname, 'shared', 'ytdlp-sites.json'),
  ]) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* next */ }
  }
  return { endpoint: '', adult: [], short: [] };
}

const SITES = loadSites();
const ENDPOINT = SITES.endpoint;

function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return ''; }
}

// Subdomains count (de.pornhub.com, i.imgur.com); look-alikes don't.
const onList = (host, list) => !!host && list.some((d) => host === d || host.endsWith('.' + d));

// #183: the list alone missed pornpics.com. A host label containing one of the
// adult words counts too (pornpics, youporn, 91porn, xxxbunker).
const adultHost = (host) =>
  onList(host, SITES.adult) ||
  (!!host && host.split('.').some((label) => (SITES.adultWords || []).some((w) => label.includes(w))));

/** Only real web pages can be sent; the new-tab page, file: and friends can't. */
const downloadable = (url) => hostOf(url) !== '';

/** What the picker starts with for this page. */
function defaults(url) {
  const host = hostOf(url);
  return { adult: adultHost(host), short: onList(host, SITES.short) };
}

/**
 * The request body. `choice` is {format, kids} plus optional adult/short
 * overrides from the picker. Kids and Adult are exclusive (Kids wins, since it
 * is the one you ticked on purpose), and audio has no adult/short folders on
 * the server, so both are cleared rather than sent as noise.
 */
function body(url, choice = {}) {
  const format = choice.format === 'audio' ? 'audio' : 'video';
  const kids = !!choice.kids;
  const d = defaults(url);
  let adult = choice.adult === undefined ? d.adult : !!choice.adult;
  let short = choice.short === undefined ? d.short : !!choice.short;
  if (kids || format === 'audio') { adult = false; short = false; }
  return { url, format, adult, short, kids };
}

// #176: an adult tab closes the moment you leave it, and never syncs or
// restores. Same list and matching as the picker's Adult default.
const isAdult = (url) => adultHost(hostOf(url));

module.exports = { ENDPOINT, downloadable, defaults, body, hostOf, isAdult };
