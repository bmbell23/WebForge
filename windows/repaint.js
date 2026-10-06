// #148: forcing a page view to actually produce a frame.
//
// The symptom, twice reported: a link opened from another app shows BLACK until
// you alt-tab away and back; a tab you return to shows BLANK WHITE until you
// reload it. Two colours, one fault — a WebContentsView that is visible but has
// not produced a frame. Black where it never painted at all, white where its
// frame was evicted while hidden.
//
// Why the first two attempts failed, since it matters for what this does:
// #148 round 1 added layout() on restore/show/focus. layout()'s only lever is
// setBounds, and **setBounds with unchanged geometry is a no-op in Chromium** —
// it never reaches the compositor, so no frame is produced. It was re-asserting
// geometry that was already correct. Alt-tab works precisely because it changes
// OCCLUSION, which is a real compositor event; so does a resize.
//
// So the fix has to do something the compositor cannot elide:
//   1. webContents.invalidate() — the intended lever (present in Electron 34).
//   2. a 1px bounds nudge, reverted on the next tick — a genuine geometry
//      change, as a fallback for when (1) is not enough on Windows.
//
// This module holds the POLICY (when, and what geometry to nudge to) with no
// Electron in it, so it can be tested on this display-less host. The effect on
// screen cannot be tested here; that is a property of the environment, and the
// reason main.js also logs what it did.
'use strict';

/**
 * Should we force a repaint?
 *
 * @param {object} ctx
 * @param {boolean} ctx.becameVisible   the view was just shown (tab activated)
 * @param {boolean} ctx.windowReturned  the window was just restored/shown/focused
 * @param {boolean} ctx.boundsChanged   layout() actually moved or resized it
 * @param {boolean} ctx.everPainted     has this view ever produced a frame?
 * @returns {{force: boolean, reason: string}}
 */
function shouldForce(ctx) {
  const c = ctx || {};

  // A real geometry change already provokes the compositor; adding an
  // invalidate on top is noise, and this runs on every resize tick.
  if (c.boundsChanged) return { force: false, reason: 'bounds changed — the compositor already has work' };

  // The black case. A view created while the window was hidden (external link
  // into a minimised WebForge) has never painted, and nothing else will ask it to.
  if (!c.everPainted) return { force: true, reason: 'never painted' };

  // The white case. Shown again after being hidden, at identical geometry —
  // exactly where setBounds cannot help.
  //
  // #216: but only after a real absence. Forcing on EVERY tab switch meant two
  // layouts of Teams/Outlook plus a capturePage per click. A frame is only
  // evicted after the view has sat hidden a while, so a quick flip keeps it.
  // hiddenMs undefined = unknown, which keeps the old (forcing) behaviour.
  if (c.becameVisible) {
    if (c.hiddenMs !== undefined && c.hiddenMs < EVICT_MS) {
      return { force: false, reason: 'hidden too briefly to lose its frame' };
    }
    return { force: true, reason: 'became visible at unchanged geometry' };
  }

  // The window came back from minimise/occlusion with the same size as before.
  // #216: a plain focus (alt-tab between two visible windows) never hid it.
  if (c.windowReturned) {
    if (c.windowWasHidden === false) return { force: false, reason: 'window was never hidden' };
    return { force: true, reason: 'window returned at unchanged geometry' };
  }

  return { force: false, reason: 'nothing to provoke' };
}

// #216: how long a view must sit hidden before re-showing it forces a repaint.
const EVICT_MS = 2 * 60 * 1000;

/**
 * A geometry that differs from `bounds` by one pixel, for the fallback nudge.
 *
 * Shrinks rather than grows: growing can push the view past the window edge,
 * where the change may be clipped away and elided — which would make the nudge
 * silently useless, the same way setBounds already is.
 */
function nudgeBounds(bounds) {
  const b = bounds || {};
  const width = Number(b.width) || 0;
  const height = Number(b.height) || 0;
  // Too small to shrink safely — a zero or negative dimension is worse than no
  // nudge, so grow instead and accept the edge risk in this rare case.
  if (width <= 1 || height <= 1) {
    return { x: b.x | 0, y: b.y | 0, width: width + 1, height: height + 1 };
  }
  return { x: b.x | 0, y: b.y | 0, width: width - 1, height: height - 1 };
}

/** Did a nudge actually change anything? A no-op nudge is the bug, not the fix. */
function isDistinct(a, b) {
  if (!a || !b) return false;
  return a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height;
}

// #148 round 3 was wrong about the mechanism, and the user's report is what
// showed it: after setBackgroundColor('#ffffff') the failure went from BLACK to
// WHITE. Black was the view's default background; white is the colour we asked
// for. So the view's own layer WAS being composited the whole time — the pixels
// on screen were ours. What never arrived was the RENDERER's content.
//
// That rules out "the view isn't attached to the compositor", which is what
// invalidate() and a bounds nudge address. The renderer believes it is hidden
// and is not producing frames at all. The lever for that is its VISIBILITY
// state, which only changes when visibility itself changes — a view that was
// made visible while the window was hidden is already "visible" as far as the
// bookkeeping is concerned, so nothing re-pushes the state when the window
// finally appears.
//
// Hence an escalation, cheapest and most targeted first:
//
//   visibility  setVisible(false) then (true) across a tick — forces the
//               renderer visibility state to be recomputed and re-pushed.
//               This is the one aimed at the actual fault.
//   invalidate  webContents.invalidate() — asks for a repaint.
//   nudge       a 1px geometry change, which the compositor cannot elide.
//   capture     capturePage() — forces the renderer to produce a frame in
//               order to satisfy the capture. Heaviest, and last.
const LEVERS = ['visibility', 'invalidate', 'nudge', 'capture'];

/**
 * Which levers to pull. `attempt` is 0 for the first try at a given moment and
 * 1 for the retry after the page finishes loading — by then anything still
 * blank needs everything.
 */
function leversFor(ctx, attempt) {
  const c = ctx || {};
  if (!shouldForce(c).force) return [];

  const levers = [];

  // The visibility toggle ONLY where visibility did not just change.
  //
  // Shipped in 0.1.160 without this condition and it broke typing across the
  // app: at tab activation, and again on every did-stop-loading, the toggle
  // hid the view — and activateTab calls webContents.focus() immediately
  // afterwards, so focus landed on a hidden view and every bare key ([ and ]
  // on Gerrit, Ctrl+S for link hints) went nowhere. That is #30 reintroduced,
  // whose comment sits two lines from the damage.
  //
  // It is also redundant there: activateTab's own setVisible(true) IS the real
  // transition the renderer needs. Only the window-return case has genuinely
  // unchanged visibility, so only it needs this.
  if (c.windowReturned && !c.becameVisible) levers.push('visibility');

  levers.push('invalidate', 'nudge');

  // capturePage is the heavy one: reserved for a view that has never painted
  // (the external-link case) or a retry, where cheaper levers already failed.
  if (!c.everPainted || attempt > 0) levers.push('capture');

  return levers;
}

module.exports = { shouldForce, nudgeBounds, isDistinct, leversFor, LEVERS, EVICT_MS };
