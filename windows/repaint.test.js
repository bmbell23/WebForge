// #148 tests:  node windows/repaint.test.js
const assert = require('assert');
const { shouldForce, nudgeBounds, isDistinct, EVICT_MS } = require('./repaint');

let run = 0;
const test = (name, fn) => {
  fn();
  run++;
  console.log(`  ok  ${name}`);
};

console.log('the two reported symptoms');

test('a view that has never painted is forced (the BLACK external-link case)', () => {
  // A link from the terminal into a minimised WebForge: the view is created
  // while hidden, never paints, and nothing else will ask it to.
  const d = shouldForce({ everPainted: false, becameVisible: true, windowReturned: true, boundsChanged: false });
  assert.strictEqual(d.force, true);
  assert.ok(/never painted/.test(d.reason));
});

test('a view shown again at the same size is forced (the WHITE tab-back case)', () => {
  const d = shouldForce({ everPainted: true, becameVisible: true, boundsChanged: false });
  assert.strictEqual(d.force, true);
  assert.ok(/became visible/.test(d.reason));
});

test('the window returning from minimise is forced', () => {
  const d = shouldForce({ everPainted: true, becameVisible: false, windowReturned: true, boundsChanged: false });
  assert.strictEqual(d.force, true);
});

console.log('and it must not fire when the compositor already has work');

test('a real bounds change does NOT also force a repaint', () => {
  // This is the case setBounds handles correctly; forcing here would add an
  // invalidate to every frame of a window drag.
  const d = shouldForce({ everPainted: true, becameVisible: true, windowReturned: true, boundsChanged: true });
  assert.strictEqual(d.force, false);
  assert.ok(/already has work/.test(d.reason));
});

test('a steady visible view is left alone', () => {
  assert.strictEqual(
    shouldForce({ everPainted: true, becameVisible: false, windowReturned: false, boundsChanged: false }).force,
    false
  );
});

test('missing context never forces and never throws', () => {
  // An absent everPainted reads as "not painted", which errs toward repainting
  // a healthy view rather than leaving a black one — the right way to be wrong.
  for (const ctx of [null, undefined, {}]) {
    assert.doesNotThrow(() => shouldForce(ctx));
  }
  assert.strictEqual(shouldForce({}).force, true, 'unknown paint state errs toward painting');
});

console.log('the fallback nudge must actually change geometry');

test('a nudge differs from the original — a no-op nudge IS the bug', () => {
  const b = { x: 240, y: 0, width: 1200, height: 800 };
  const n = nudgeBounds(b);
  assert.ok(isDistinct(b, n), 'nudge must not equal the original or it changes nothing');
});

test('the nudge SHRINKS, so it cannot be clipped away at the window edge', () => {
  const n = nudgeBounds({ x: 240, y: 0, width: 1200, height: 800 });
  assert.strictEqual(n.width, 1199);
  assert.strictEqual(n.height, 799);
  assert.strictEqual(n.x, 240, 'position must not move — that would be visible');
  assert.strictEqual(n.y, 0);
});

test('a degenerate size grows instead of going to zero or negative', () => {
  for (const b of [{ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 0 }]) {
    const n = nudgeBounds(b);
    assert.ok(n.width > 0 && n.height > 0, `${JSON.stringify(b)} -> ${JSON.stringify(n)}`);
    assert.ok(isDistinct(b, n));
  }
});

test('nudging junk does not throw and still yields usable bounds', () => {
  for (const b of [null, undefined, {}, { width: 'x', height: null }]) {
    const n = nudgeBounds(b);
    assert.ok(Number.isFinite(n.width) && Number.isFinite(n.height));
    assert.ok(n.width > 0 && n.height > 0);
  }
});

console.log('isDistinct is the guard that proves a nudge bit');

test('identical bounds are not distinct', () => {
  const b = { x: 1, y: 2, width: 3, height: 4 };
  assert.strictEqual(isDistinct(b, { ...b }), false);
  assert.strictEqual(isDistinct(b, { ...b, width: 4 }), true);
  assert.strictEqual(isDistinct(null, b), false);
});

console.log('which levers get pulled (round 4 — the renderer, not the view)');

const { leversFor, LEVERS } = require('./repaint');

test('THE 0.1.160 REGRESSION: no visibility toggle when the view just became visible', () => {
  // Shipped without this and it broke typing everywhere: the toggle hid the
  // view, activateTab then focused a hidden view, and every bare key on the
  // page went nowhere ([ and ] on Gerrit, Ctrl+S for hints). #30 reintroduced.
  for (const ctx of [
    { everPainted: false, becameVisible: true },
    { everPainted: true, becameVisible: true },
    { everPainted: true, becameVisible: true, windowReturned: true },
  ]) {
    assert.ok(
      !leversFor(ctx, 0).includes('visibility'),
      `must not toggle visibility for ${JSON.stringify(ctx)} — it drops keyboard focus`
    );
  }
});

test('...and the did-stop-loading retry must not toggle it either', () => {
  // This fired on EVERY page load, which is what made Gerrit unusable.
  assert.ok(!leversFor({ everPainted: true, becameVisible: true }, 1).includes('visibility'));
});

test('the window-return case DOES toggle visibility — there it is the only lever that fits', () => {
  // Returning from minimise at unchanged size is the one moment visibility
  // genuinely did not change, so nothing else re-pushes the renderer state.
  const l = leversFor({ everPainted: true, windowReturned: true }, 0);
  assert.strictEqual(l[0], 'visibility');
});

test('a never-painted view gets capturePage; a healthy one does not', () => {
  assert.ok(leversFor({ everPainted: false, becameVisible: true }, 0).includes('capture'));
  assert.ok(!leversFor({ everPainted: true, becameVisible: true }, 0).includes('capture'));
});

test('invalidate and nudge always run when forcing at all', () => {
  for (const ctx of [
    { everPainted: false, becameVisible: true },
    { everPainted: true, becameVisible: true },
    { everPainted: true, windowReturned: true },
  ]) {
    const l = leversFor(ctx, 0);
    assert.ok(l.includes('invalidate') && l.includes('nudge'), JSON.stringify(ctx));
  }
});

test('no levers when the policy says not to force', () => {
  assert.deepStrictEqual(leversFor({ everPainted: true, boundsChanged: true, becameVisible: true }, 0), []);
  assert.deepStrictEqual(leversFor({ everPainted: true }, 0), []);
});

test('leversFor never returns the shared array, so a caller cannot corrupt it', () => {
  const a = leversFor({ everPainted: false }, 0);
  a.push('nonsense');
  assert.deepStrictEqual(LEVERS, ['visibility', 'invalidate', 'nudge', 'capture']);
});

console.log('#216: not on every tab switch');

test('a quick flip back to a painted tab does NOT force (it still has its frame)', () => {
  const d = shouldForce({ everPainted: true, becameVisible: true, boundsChanged: false, hiddenMs: 5000 });
  assert.strictEqual(d.force, false);
  assert.deepStrictEqual(leversFor({ everPainted: true, becameVisible: true, hiddenMs: 5000 }, 0), []);
});

test('a tab hidden past the eviction window IS forced (the WHITE case survives)', () => {
  const d = shouldForce({ everPainted: true, becameVisible: true, boundsChanged: false, hiddenMs: EVICT_MS });
  assert.strictEqual(d.force, true);
});

test('a never-painted view is forced however briefly it was hidden', () => {
  assert.strictEqual(shouldForce({ everPainted: false, becameVisible: true, hiddenMs: 10 }).force, true);
});

test('focus without the window having been hidden does NOT force', () => {
  const d = shouldForce({ everPainted: true, windowReturned: true, windowWasHidden: false });
  assert.strictEqual(d.force, false);
});

test('restore after a real minimise IS forced', () => {
  assert.strictEqual(shouldForce({ everPainted: true, windowReturned: true, windowWasHidden: true }).force, true);
});

console.log(`\n${run} tests passed`);
