// #238: notice a tab that keeps navigating itself. A page that reloads or
// re-routes every couple of seconds looks like "flashing white", and nothing
// logged it, so the PC log could not say what Outlook was doing. Electron-free
// (navloop.test.js); main.js feeds it every main-frame navigation start.
'use strict';

function createNavLoop({ windowMs = 30000, threshold = 5, quietMs = 60000 } = {}) {
  let recent = []; // { at, url, kind }
  let lastReport = -Infinity;
  /** Note one navigation; returns a report string when the tab is looping, else null. */
  return function note(url, kind, now = Date.now()) {
    recent = recent.filter((r) => now - r.at < windowMs);
    recent.push({ at: now, url: String(url || ''), kind });
    if (recent.length < threshold || now - lastReport < quietMs) return null;
    lastReport = now;
    const lines = recent.map((r) => `+${Math.round((r.at - recent[0].at) / 100) / 10}s ${r.kind} ${r.url.slice(0, 160)}`);
    return `${recent.length} main-frame navigations in ${Math.round(windowMs / 1000)}s\n${lines.join('\n')}`;
  };
}

module.exports = { createNavLoop };
