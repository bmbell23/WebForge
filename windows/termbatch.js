// #216: coalesces ssh output into fewer IPC messages. Electron-free so it
// runs under plain node (termbatch.test.js).
function createBatcher(flush, { delayMs = 8, maxBytes = 65536 } = {}) {
  let chunks = [];
  let bytes = 0;
  let timer = null;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const flushNow = () => {
    clear();
    if (!chunks.length) return;
    const out = Buffer.concat(chunks);
    chunks = [];
    bytes = 0;
    flush(out);
  };
  const push = (buf) => {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    chunks.push(b);
    bytes += b.length;
    if (bytes >= maxBytes) flushNow();
    else if (!timer) timer = setTimeout(flushNow, delayMs);
  };
  const cancel = () => {
    clear();
    chunks = [];
    bytes = 0;
  };
  return { push, flushNow, cancel };
}

module.exports = { createBatcher };
