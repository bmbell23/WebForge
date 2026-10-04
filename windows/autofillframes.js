// #141: run the autofill script in every frame of a page that may hold the
// login form, not just the top document.
//
// wc.executeJavaScript only reaches the main frame, and Schwab — like most
// banks and hosted SSO — puts the entire login form in an iframe, so autofill
// found nothing there and gave up. Electron exposes every frame as a
// WebFrameMain with its own .url and .executeJavaScript(); this walks them.
//
// Electron-free (frames are passed in) so the decisions are unit-testable in
// autofillframes.test.js, and scripts/autofill-dom-check.js drives the same
// function against real Chromium frames.
const credmatch = require('./credmatch');
const autofillInject = require('./autofill-inject');

const frameId = (f) => (f && f.frameTreeNodeId !== undefined ? f.frameTreeNodeId : f);

/**
 * Every ancestor between the frame and the top must pass too. Otherwise
 * schwab.com embedding an ad from evil.com, which embeds a schwab.com login,
 * would fill a form that evil.com gets to position and clickjack.
 */
function chainMayFill(topUrl, frame, top) {
  for (let f = frame; f && frameId(f) !== frameId(top); f = f.parent) {
    if (!credmatch.mayFillFrame(topUrl, f.url)) return false;
  }
  return true;
}

/**
 * Which frames to try, and with which credential. The top frame comes first so
 * an ordinary login page behaves exactly as before; each subframe's credential
 * is picked from that frame's OWN URL (the form posts there), gated by
 * mayFillFrame on the whole ancestor chain.
 */
function planFills(entries, mainFrame) {
  const topUrl = mainFrame.url;
  const subframes = (mainFrame.framesInSubtree || []).filter((f) => frameId(f) !== frameId(mainFrame));
  const plan = [];
  for (const frame of [mainFrame, ...subframes]) {
    const url = frame.url;
    if (!credmatch.mayFillFrame(topUrl, url)) continue; // also skips about:blank / data:
    if (!chainMayFill(topUrl, frame, mainFrame)) continue;
    const match = credmatch.bestMatch(entries, url);
    if (match) plan.push({ frame, url, match });
  }
  return plan;
}

/**
 * Returns 'filled' | 'user' | false, the same contract as autofill-inject.js:
 * 'filled' as soon as any frame fills (later frames are left alone), 'user' if
 * some frame took a two-step username, false otherwise.
 */
async function fillFrames(mainFrame, entries, mayFillUsername = true) {
  if (!mainFrame) return false;
  let user = false;
  for (const { frame, url, match } of planFills(entries, mainFrame)) {
    // A frame that navigated or went away since planning gets nothing: the
    // credential was chosen for the URL it HAD.
    let still;
    try {
      still = !frame.detached && frame.url === url;
    } catch {
      still = false;
    }
    if (!still) continue;
    const result = await Promise.resolve()
      .then(() => frame.executeJavaScript(autofillInject.fillScript(match.username, match.password, mayFillUsername), true))
      .catch(() => false);
    if (result === 'filled') return 'filled';
    if (result === 'user') user = true;
  }
  return user ? 'user' : false;
}

module.exports = { planFills, fillFrames, chainMayFill };
