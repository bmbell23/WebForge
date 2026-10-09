// #170 round 2: "links stop working from anywhere until restart", and the
// shipped log went silent at the same time. Nothing recorded a hung helper
// process, a stalled main thread or a navigation that never finished, so the
// failure was invisible. These are the pure parts of that watch.
//
// Electron-free, so the rules are unit-testable without a Windows machine.

/** Main-thread stall: call tick(now) on a fixed interval; returns the lag (ms) when it is over `threshold`. */
function stallTracker(intervalMs, threshold) {
  let last = null;
  return {
    tick(now) {
      const prev = last;
      last = now;
      if (prev === null) return 0;
      const lag = now - prev - intervalMs;
      return lag > threshold ? lag : 0;
    },
    reset(now) {
      last = now;
    },
  };
}

/** Main-frame navigations that started and never finished. Each is reported once. */
function navTracker() {
  const open = new Map(); // tabId -> { url, at, reported }
  return {
    start(id, url, now) {
      open.set(id, { url, at: now, reported: false });
    },
    end(id) {
      open.delete(id);
    },
    overdue(now, ms) {
      const out = [];
      for (const [id, n] of open) {
        if (!n.reported && now - n.at > ms) {
          n.reported = true;
          out.push({ id, url: n.url, ageMs: now - n.at });
        }
      }
      return out;
    },
    size: () => open.size,
  };
}

/** Network probe: returns a log line only when the state flips, so a healthy day logs nothing. */
function probeState() {
  let ok = null;
  return (nowOk, detail) => {
    if (nowOk === ok) return null;
    const first = ok === null;
    ok = nowOk;
    if (first && nowOk) return null;
    return nowOk ? `recovered ${detail || ''}`.trim() : `failing ${detail || ''}`.trim();
  };
}

module.exports = { stallTracker, navTracker, probeState };
