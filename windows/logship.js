// #171: ship errors.log entries to the sync server.
//
// errors.log lives on the PC (#75), so every Windows bug report has meant
// Brandon reading Settings → Diagnostics back to us. This queues each entry and
// POSTs it to :8013/logs/<device>, where it can be read from the server.
//
// A send that fails keeps its batch for the next flush, so a stretch offline
// arrives late rather than never. The queue is capped and drops the OLDEST
// entries first: the newest are the ones closest to whatever just went wrong.
//
// Electron-free on purpose (see CLAUDE.md): fetch and the clock are injected so
// node can test it on this display-less host.
'use strict';

const MAX_QUEUE = 500;
const BATCH = 100;

/** A hostname turned into something safe for a URL path and a filename. */
function deviceName(host) {
  const clean = String(host || '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return clean || 'unknown';
}

/**
 * @param {object} opts
 * @param {string} opts.url       endpoint, e.g. http://host:8013/logs/<device>
 * @param {string} opts.version   app version stamped on every batch
 * @param {Function} opts.fetch   fetch(url, init) -> Promise<{ok:boolean}>
 * @param {number} [opts.max]     queue cap
 * @param {number} [opts.batch]   entries per POST
 */
function create(opts) {
  const max = opts.max || MAX_QUEUE;
  const batch = opts.batch || BATCH;
  let queue = [];
  let dropped = 0;
  let inFlight = null;

  function push(entry) {
    queue.push(entry);
    if (queue.length > max) {
      dropped += queue.length - max;
      queue = queue.slice(-max);
    }
  }

  /** Send everything queued, a batch at a time. Resolves true if the queue emptied. */
  function flush() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        while (queue.length) {
          const sent = queue.slice(0, batch);
          const lost = dropped;
          const entries = sent.slice();
          // Tell the server how much the cap threw away, once, in the next batch.
          if (lost) {
            entries.unshift({ at: new Date().toISOString(), where: 'logship', body: `dropped ${lost} entries (queue full)` });
          }
          let ok = false;
          try {
            const res = await opts.fetch(opts.url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ version: opts.version, entries }),
              signal: AbortSignal.timeout(5000),
            });
            ok = !!(res && res.ok);
          } catch {
            ok = false;
          }
          if (!ok) return false; // keep the batch; the next flush retries it
          // By identity, not position: entries pushed (or capped away) while
          // the POST was in flight must not shift what counts as sent.
          const done = new Set(sent);
          queue = queue.filter((e) => !done.has(e));
          dropped -= lost;
        }
        return true;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return { push, flush, size: () => queue.length };
}

module.exports = { create, deviceName, MAX_QUEUE };
