// #21: Ghostery's adblocker-electron 2.x enables itself with
// `session.registerPreloadScript`, which only exists from Electron 35. On our
// Electron 34 the call threw a TypeError before any webRequest listener was
// attached, so ad blocking silently did nothing at all. Electron 34 has the
// older `setPreloads`/`getPreloads` pair; this fills the newer API in on top of
// it. A no-op on Electron 35+ (we are on 44, where the native API exists; the
// deprecated setPreloads/getPreloads fallback below is dead code kept only as a guard).

/** Give `ses` registerPreloadScript/unregisterPreloadScript if it lacks them. Returns true if shimmed. */
function ensurePreloadRegistration(ses) {
  if (typeof ses.registerPreloadScript === 'function') return false;
  const paths = new Map(); // id -> filePath
  let next = 0;
  ses.registerPreloadScript = ({ filePath }) => {
    const id = `webforge-preload-${next++}`;
    paths.set(id, filePath);
    const current = ses.getPreloads();
    if (!current.includes(filePath)) ses.setPreloads([...current, filePath]);
    return id;
  };
  ses.unregisterPreloadScript = (id) => {
    const filePath = paths.get(id);
    if (filePath === undefined) return;
    paths.delete(id);
    if ([...paths.values()].includes(filePath)) return; // still registered under another id
    ses.setPreloads(ses.getPreloads().filter((p) => p !== filePath));
  };
  return true;
}

module.exports = { ensurePreloadRegistration };
