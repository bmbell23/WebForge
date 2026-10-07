// #298: the pure half of cross-device tab sync (#57) — which other devices still
// count, and what their tabs look like as a list. Electron-free so plain `node`
// can test it (see CLAUDE.md). android/.../TabSync.kt mirrors it; the two must agree.
//
// Devices no longer ADOPT each other's open tabs (every device ended up carrying
// the union). Their open facts are only listed on demand; their CLOSE facts still
// reach every device through the merge in main.js.
'use strict';

const { canonical } = require('./taburl');

const STALE_MS = 3 * 24 * 3600 * 1000; // a device silent this long is forgotten
const TOMBSTONE_TTL = 30 * 24 * 3600 * 1000; // same TTL as main.js closedFacts

/**
 * What to write back to the store. Other devices whose `at` is older than
 * [maxAgeMs] lose their OPEN facts (so they shed and are never listed).
 * Close facts live inside the device entry, and a live device that was offline
 * may not have applied them yet, so a stale device keeps its close facts (still
 * within the tombstone TTL) and is dropped outright only when none remain.
 * [me] is never touched. Input is not mutated.
 */
function pruneStaleDevices(devices, now, maxAgeMs = STALE_MS, me = null) {
  const out = {};
  for (const [id, dev] of Object.entries(devices || {})) {
    if (!dev || typeof dev !== 'object') continue;
    if (id === me || now - (Number(dev.at) || 0) <= maxAgeMs) {
      out[id] = dev;
      continue;
    }
    const personas = {};
    for (const [pid, block] of Object.entries(dev.personas || {})) {
      const closed = {};
      for (const [url, at] of Object.entries((block && block.closed) || {})) {
        if (now - at <= TOMBSTONE_TTL) closed[url] = at;
      }
      if (Object.keys(closed).length) personas[pid] = { closed };
    }
    if (Object.keys(personas).length) out[id] = { ...dev, personas };
  }
  return out;
}

/** True when [dev] is silent past the cutoff (never true for [me]). */
function isStale(dev, now, maxAgeMs = STALE_MS) {
  return now - (Number(dev && dev.at) || 0) > maxAgeMs;
}

/**
 * The "From other devices" list: [{device, at, tabs:[{title,url,at}]}], groups
 * and tabs newest first. Skips this device, silent devices (when [now] is given),
 * adult URLs and URLs already open here (compared canonically, #152).
 * Devices sharing a name merge into one group; a URL appears once.
 */
function otherDeviceTabs(devices, me, openUrls, isAdult, now = null, maxAgeMs = STALE_MS) {
  const open = new Set([...(openUrls || [])].map((u) => canonical(u)));
  const groups = new Map(); // device name -> { device, at, seen:Set, tabs }
  for (const [id, dev] of Object.entries(devices || {})) {
    if (id === me || !dev) continue;
    if (now !== null && isStale(dev, now, maxAgeMs)) continue;
    const name = dev.name || id;
    for (const block of Object.values(dev.personas || {})) {
      for (const [url, info] of Object.entries((block && block.open) || {})) {
        const key = canonical(url);
        if (open.has(key) || (isAdult && isAdult(url))) continue;
        const g = groups.get(name) || { device: name, at: 0, seen: new Map(), tabs: [] };
        groups.set(name, g);
        const at = Number(info && info.at) || 0;
        const prev = g.seen.get(key);
        if (prev) {
          if (at > prev.at) { prev.at = at; prev.title = (info && info.title) || url; }
          continue;
        }
        const tab = { title: (info && info.title) || url, url, at };
        g.seen.set(key, tab);
        g.tabs.push(tab);
      }
    }
  }
  const out = [];
  for (const g of groups.values()) {
    g.tabs.sort((a, b) => b.at - a.at);
    out.push({ device: g.device, at: g.tabs[0].at, tabs: g.tabs });
  }
  return out.sort((a, b) => b.at - a.at);
}

module.exports = { pruneStaleDevices, otherDeviceTabs, isStale, STALE_MS };
