// #151: whether a store should push, pull, or do nothing.
//
// This exists because of a data-loss incident on 2026-09-23. Installing WebForge
// on a NEW computer destroyed every Persona rule on every device:
//
//   1. a first run has no personas.json, so defaults() was used
//   2. defaults() stamped `updatedAt: Date.now()` — newer than anything on the server
//   3. syncPersonas() saw localAt > remoteAt and PUSHED empty defaults
//   4. the other machine pulled the empties
//
// The bug was an asymmetry. The PULL side already refused empty remote data
// (`remote.data.length`); the PUSH side had no equivalent check. The protection
// existed and faced the wrong way.
//
// So the rule here, and it is not a heuristic:
//
//   ** A store with no user data in it may never overwrite one that has some. **
//
// Timestamps decide between two populated stores. They do NOT get to decide that
// nothing should replace something, because "nothing" is what every fresh install
// and every failed load looks like, and those are exactly the moments a clock
// comparison is least trustworthy.
//
// Electron-free so it can be tested with plain `node` (see CLAUDE.md).
'use strict';

/**
 * @param {number} localAt      local updatedAt, ms
 * @param {number} remoteAt     remote updatedAt, ms
 * @param {number} localWeight  how much USER data is held locally (rules,
 *                              bookmarks — whatever would be mourned if lost)
 * @param {number} remoteWeight the same measure, remotely
 * @returns {{action: 'push'|'pull'|'none', reason: string}}
 */
function decide({ localAt, remoteAt, localWeight, remoteWeight }) {
  const lAt = Number(localAt) || 0;
  const rAt = Number(remoteAt) || 0;
  const lW = Number(localWeight) || 0;
  const rW = Number(remoteWeight) || 0;

  if (rAt > lAt) {
    // Pulling nothing over something is the same mistake in the other
    // direction — it would wipe this device instead of the server.
    if (rW === 0 && lW > 0) {
      return { action: 'none', reason: 'remote is empty and local has data — refusing to pull' };
    }
    if (rW === 0) return { action: 'none', reason: 'remote is empty and so are we' };
    return { action: 'pull', reason: 'remote is newer' };
  }

  if (lAt > rAt) {
    // THE #151 GUARD. A fresh install, a corrupt file, a failed read — all look
    // identical here, and all would otherwise clobber the real data.
    if (lW === 0 && rW > 0) {
      return { action: 'none', reason: 'local is empty and remote has data — refusing to push' };
    }
    if (lW === 0) return { action: 'none', reason: 'nothing worth pushing' };
    return { action: 'push', reason: 'local is newer' };
  }

  return { action: 'none', reason: 'in step' };
}

/** How much user data a Persona set holds: rules are the thing worth losing. */
function personaWeight(list) {
  if (!Array.isArray(list)) return 0;
  return list.reduce((n, p) => n + ((p && Array.isArray(p.rules) ? p.rules.length : 0)), 0);
}

/** Bookmarks: the count is the measure. */
function bookmarkWeight(list) {
  return Array.isArray(list) ? list.length : 0;
}

module.exports = { decide, personaWeight, bookmarkWeight };
