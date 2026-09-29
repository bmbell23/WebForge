// #131: keyboard access to the chrome surfaces.
//
// Without a mouse there was no way to reach the tab sidebar or the bookmarks
// panel at all: the chrome UI contained zero `tabindex` attributes, so the rows
// were plain `div`s with `onclick` that Tab could never land on.
//
// **There is no focus-cycling key.** Round 1 of this ticket added F6 because that
// is what Chrome and Firefox use for moving between panes. The user's reaction
// ("wtf is that shit") settled it: a convention nobody reaches for is not a
// feature. What actually works, with no new binding at all:
//
//   Ctrl+L  focus the address bar
//   Tab     walk forward through the chrome (works now the rows are focusable)
//   Enter   open the focused tab or bookmark; Delete closes a tab
//   Ctrl+B  open the bookmarks panel AND put focus in it
//   Esc     hand focus back to the page
//
// So all this module holds is which side owns a surface, which is the one thing
// main needs to decide between focusing chrome and focusing the page view. It
// stays a module rather than an inline constant because Esc's behaviour depends
// on it and that is worth a test.
'use strict';

const PAGE = 'page';

// Surfaces the chrome renderer owns. 'page' is the content view, which main
// focuses directly.
const CHROME_SURFACES = ['tabs', 'url', 'bookmarks'];

/** Is this a surface the chrome UI owns, rather than the page view? */
function isChromeSurface(surface) {
  return CHROME_SURFACES.includes(surface);
}

/** Escape, and any bail-out: focus belongs to the page. */
function escapeTarget() {
  return PAGE;
}

module.exports = { PAGE, CHROME_SURFACES, isChromeSurface, escapeTarget };
