// #107: the order the sidebar actually shows tabs in.
//
// The bug this exists to fix: `tabOrder` is only weight-sorted (hotkey, pinned,
// normal) and knows nothing about hotkey-key ordering or tab groups, while the
// SIDEBAR renders Hotkeys (sorted by key) → Pinned → group buckets → loose tabs.
// Ctrl+PageUp / Ctrl+PageDown walked `tabOrder`, so stepping "down the list"
// jumped around the screen, because the list being walked was not the list being
// looked at.
//
// One implementation, used by main for BOTH what it sends the sidebar and what
// the cycling chords walk, so the two can no longer disagree. Electron-free, so
// it is unit-testable here.

/** Mirrors the sidebar's group naming: a custom pattern group, else the host. */
function bucketFor(url, groups, matchPattern) {
  const custom = (groups || []).find((g) => g && g.pattern && matchPattern(url, g.pattern));
  if (custom) return custom.name;
  try {
    return new URL(url).hostname.replace(/^www\./, '') || '(local)';
  } catch {
    return '(local)';
  }
}

/** #44: hotkey tabs read as a keyboard map, so they sort by key, numerically. */
function byHotkey(tabs) {
  return tabs
    .slice()
    .sort((a, b) => String(a.hotkey).localeCompare(String(b.hotkey), undefined, { numeric: true }));
}

/**
 * #142: inside a section, hotkey tabs come first and keep their key order.
 *
 * Without this, moving hotkey tabs into groups quietly destroyed #44: three
 * quick-launch tabs sharing a host now form a bucket, and they would have been
 * drawn in tab-creation order rather than by key. A hotkey list that is not in
 * key order is not a keyboard map any more — which is the whole point of #44.
 * (The existing #44 test caught exactly this, which is why it is worth having.)
 */
function orderWithin(tabs) {
  return [...byHotkey(tabs.filter((t) => t.hotkey)), ...tabs.filter((t) => !t.hotkey)];
}

/**
 * Sort `tabs` into the sequence the sidebar displays.
 *
 * @param tabs  [{ id, url, hotkey, pinned }] in whatever order
 * @param groups  custom pattern groups from settings (#34)
 * @param matchPattern  (url, pattern) => boolean — supplied by the caller so
 *        this module stays free of the pattern implementation
 * @returns the same objects, reordered
 */
function displayOrder(tabs, groups, matchPattern) {
  const list = Array.isArray(tabs) ? tabs.slice() : [];

  const pinned = list.filter((t) => !t.hotkey && t.pinned);
  // #142: hotkey tabs take part in bucketing now. They used to be hoisted out
  // to the Hotkeys section unconditionally, so a quick-launch tab never
  // appeared alongside the group it obviously belonged to. Pinned tabs keep
  // their own section — that was not part of the request.
  const bucketable = list.filter((t) => !t.pinned);

  // #34: named pattern groups and multi-tab host buckets are sections; a host
  // with a single tab falls through to the loose list at the bottom.
  const buckets = new Map(); // insertion-ordered, which is the displayed order
  for (const t of bucketable) {
    const name = bucketFor(t.url, groups, matchPattern);
    if (!buckets.has(name)) {
      buckets.set(name, { name, custom: (groups || []).some((g) => g && g.name === name), tabs: [] });
    }
    buckets.get(name).tabs.push(t);
  }

  const grouped = [];
  const looseHot = [];
  const singles = [];
  for (const b of buckets.values()) {
    // #142: a hotkey tab joins a section that already exists — it does not
    // CONVENE one out of hotkey tabs alone. Two quick-launch tabs that happen
    // to share a host are not "a tab group"; treating them as one would break
    // up the Hotkeys section, which is a deliberate keyboard map (#44), in
    // exchange for a group nobody asked for. A custom pattern group (#34) is
    // deliberate by definition, so hotkey tabs do join those on their own.
    const hasOrdinary = b.tabs.some((t) => !t.hotkey);
    if (b.custom || (b.tabs.length >= 2 && hasOrdinary)) {
      grouped.push(...orderWithin(b.tabs));
    } else {
      for (const t of b.tabs) (t.hotkey ? looseHot : singles).push(t);
    }
  }

  // #142: only hotkey tabs that landed in NO section keep the Hotkeys header.
  // #44: those are still listed by their key, not by when they were opened.
  const hot = byHotkey(looseHot);

  return [...hot, ...pinned, ...grouped, ...singles];
}

module.exports = { displayOrder, bucketFor };
