// #113/#114: which tab a navigation chord should land on.
//
// Deliberately free of Electron so it can be unit-tested with plain `node`
// (see tabnav.test.js). Repeated bugs this session shipped because the logic was
// only verifiable by running the app on Windows, which this build host does not
// have — the same trick that let #55's vault crypto be proven without a device.
//
// Both take the candidate list and return a tab id, or null when there is
// nowhere to go. nextInOrder (Ctrl+PageUp/PageDown) gets the active Persona's
// tabs (#75); mostRecent (Ctrl+Tab) gets every tab in every Persona (#226).

/**
 * Step `dir` places through `list` from `activeId`, wrapping at the ends.
 * Falls back to the first entry when the active tab is not in the list.
 */
function nextInOrder(list, activeId, dir) {
  if (!Array.isArray(list) || list.length < 2) return null;
  const idx = list.indexOf(activeId);
  return list[(Math.max(idx, 0) + dir + list.length) % list.length];
}

/**
 * The most recently used tab OTHER than the active one — the Alt+Tab flip.
 *
 * Resolved by identity rather than position, so it is unaffected by the list
 * shifting between presses, which is the failure mode behind #114.
 *
 * `lastActiveAt` is anything with a `.get(id)` returning a timestamp; ties and
 * missing timestamps fall back to list order, so the result is always defined.
 */
function mostRecent(list, activeId, lastActiveAt) {
  if (!Array.isArray(list)) return null;
  const others = list.filter((id) => id !== activeId);
  if (!others.length) return null;
  const at = (id) => (lastActiveAt && lastActiveAt.get(id)) || 0;
  return others.reduce((best, id) => (at(id) > at(best) ? id : best));
}

/**
 * #289: the tab to land on after closing `id` — the one BELOW it in `order`
 * (the Persona's sidebar order), or the one ABOVE when it was last. Null when
 * `id` is not in the list or was its only entry (the caller opens a fresh tab).
 */
function afterClose(order, id) {
  if (!Array.isArray(order)) return null;
  const idx = order.indexOf(id);
  if (idx < 0) return null;
  if (idx + 1 < order.length) return order[idx + 1];
  if (idx > 0) return order[idx - 1];
  return null;
}

module.exports = { nextInOrder, mostRecent, afterClose };
