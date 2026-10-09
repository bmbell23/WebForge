// #333: after a restart, logins don't stick, per-site settings vanish and
// Mattermost hangs on "Loading". The PC's Cookies and Local Storage files stopped
// being written at the moment of a restart (17:52:30Z on 2026-10-09) and stayed
// frozen through hours of signing in. Killing every WebForge process by hand
// fixed it, and a plain restart broke it again. A process from the previous run
// (most likely its network service) outlives the app and keeps those files
// locked, so the new instance's network service falls back to memory-only
// storage: nothing is saved, and every launch starts logged out.
//
// The single-instance lock has just been granted to us, so any other
// WebForge.exe that is not our own child belongs to a previous run. Those are
// what this picks out.
//
// Electron-free, so the rule is unit-testable without a Windows machine.

/**
 * procs: [{ pid, ppid, name }] for every WebForge.exe. Returns the pids that are
 * neither us nor descended from us.
 */
function pickOrphans(procs, selfPid) {
  const list = Array.isArray(procs) ? procs : [];
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const ours = (p) => {
    const seen = new Set();
    let cur = p;
    while (cur && !seen.has(cur.pid)) {
      if (cur.pid === selfPid || cur.ppid === selfPid) return true;
      seen.add(cur.pid);
      cur = byPid.get(cur.ppid);
    }
    return false;
  };
  return list.filter((p) => Number.isInteger(p.pid) && p.pid !== selfPid && !ours(p)).map((p) => p.pid);
}

/** Parse PowerShell `ConvertTo-Json` output (one object or an array). */
function parseProcs(json) {
  let v;
  try {
    v = JSON.parse(String(json || '').trim() || '[]');
  } catch {
    return [];
  }
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), name: String(p.Name || '') }));
}

module.exports = { pickOrphans, parseProcs };
