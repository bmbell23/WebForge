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

  // #44: hotkey tabs are listed by their key, not by when they were opened.
  const hot = list
    .filter((t) => t.hotkey)
    .sort((a, b) => String(a.hotkey).localeCompare(String(b.hotkey), undefined, { numeric: true }));
  const pinned = list.filter((t) => !t.hotkey && t.pinned);
  const rest = list.filter((t) => !t.hotkey && !t.pinned);

  // #34: named pattern groups and multi-tab host buckets are sections; a host
  // with a single tab falls through to the loose list at the bottom.
  const buckets = new Map(); // insertion-ordered, which is the displayed order
  for (const t of rest) {
    const name = bucketFor(t.url, groups, matchPattern);
    if (!buckets.has(name)) {
      buckets.set(name, { name, custom: (groups || []).some((g) => g && g.name === name), tabs: [] });
    }
    buckets.get(name).tabs.push(t);
  }

  const grouped = [];
  const singles = [];
  for (const b of buckets.values()) {
    if (b.custom || b.tabs.length >= 2) grouped.push(...b.tabs);
    else singles.push(b.tabs[0]);
  }

  return [...hot, ...pinned, ...grouped, ...singles];
}

module.exports = { displayOrder, bucketFor };
