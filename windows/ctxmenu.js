// #133: which items a right-click menu should contain, given what was clicked.
//
// Kept separate from the actions so the DECISIONS are testable: this has six
// conditional sections, and a wrong branch shows up as a missing menu item that
// nobody notices until they need it. main.js maps each returned `id` to a click
// handler; nothing here touches Electron.
//
// `params` is Electron's context-menu payload; `ctx` supplies the two things
// only main knows — whether the selection matches a text rule (#100), and the
// current search engine's name.

const MAX_LABEL = 30;

function shorten(text) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  return clean.length > MAX_LABEL ? `${clean.slice(0, MAX_LABEL)}…` : clean;
}

/** Collapse leading/duplicate/trailing separators so the menu never looks broken. */
function tidy(items) {
  const out = [];
  for (const item of items) {
    if (item.type === 'separator') {
      if (!out.length || out[out.length - 1].type === 'separator') continue;
    }
    out.push(item);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

function build(params = {}, ctx = {}) {
  const flags = params.editFlags || {};
  const selection = String(params.selectionText || '').trim();
  const items = [];
  const sep = () => items.push({ type: 'separator' });

  if (params.linkURL) {
    items.push(
      { id: 'link.open', label: 'Open link in new tab' },
      { id: 'link.openBackground', label: 'Open link in background tab' },
      { id: 'link.copy', label: 'Copy link' },
      { id: 'link.save', label: 'Download linked file' }
    );
    // #156: the link's video/audio via the Dashboard's yt-dlp, not the raw file.
    if (ctx.linkYtdlp) items.push({ id: 'link.ytdlp', label: 'Download content from link…' });
  }

  if (params.mediaType === 'image' && params.srcURL) {
    sep();
    items.push(
      { id: 'image.open', label: 'Open image in new tab' },
      { id: 'image.copy', label: 'Copy image' },
      { id: 'image.copyAddress', label: 'Copy image link' },
      // srcURL is the element's own source, so this fetches the ORIGINAL file the
      // page loaded rather than a re-encoded copy of what is on screen.
      { id: 'image.save', label: 'Download image' }
    );
    // #179: hand the picture to the Studio to make an outfit from it.
    // #181: the label names the action, not the product.
    if (ctx.imageOutfit) items.push({ id: 'image.outfit', label: 'Create Outfit…' });
    // #177: the original file into Pictures/Downloads, tagged in Stash.
    if (ctx.mediaStash) items.push({ id: 'media.stash', label: 'Add to Stash' });
  }

  // #177: a right-clicked <video> with a real file behind it.
  if (params.mediaType === 'video' && params.srcURL && ctx.mediaStash) {
    sep();
    items.push({ id: 'media.stash', label: 'Add video to Stash' });
  }

  // A selection inside a text box belongs to the editing section below, not here.
  if (selection && !params.isEditable) {
    sep();
    // #100: only offered when a rule actually matches, so the menu never
    // advertises a jump that would go nowhere.
    if (ctx.ruleLabel) items.push({ id: 'rule.open', label: ctx.ruleLabel });
    items.push(
      { id: 'selection.copy', label: 'Copy', enabled: flags.canCopy !== false },
      { id: 'selection.search', label: `Search ${ctx.engineName || 'the web'} for "${shorten(selection)}"` }
    );
  }

  if (params.isEditable) {
    sep();
    items.push(
      { id: 'edit.undo', label: 'Undo', enabled: Boolean(flags.canUndo) },
      { id: 'edit.redo', label: 'Redo', enabled: Boolean(flags.canRedo) },
      { type: 'separator' },
      { id: 'edit.cut', label: 'Cut', enabled: Boolean(flags.canCut) },
      { id: 'edit.copy', label: 'Copy', enabled: Boolean(flags.canCopy) },
      { id: 'edit.paste', label: 'Paste', enabled: Boolean(flags.canPaste) },
      { id: 'edit.selectAll', label: 'Select all', enabled: Boolean(flags.canSelectAll) }
    );
  }

  // Always present, so a right-click on bare page still does something useful.
  sep();
  items.push(
    { id: 'nav.back', label: 'Back', enabled: Boolean(ctx.canGoBack) },
    { id: 'nav.forward', label: 'Forward', enabled: Boolean(ctx.canGoForward) },
    { id: 'nav.reload', label: 'Reload' },
    { type: 'separator' },
    // #156: same picker as the ⤓ button. Only on real web pages.
    ...(ctx.pageYtdlp ? [{ id: 'page.ytdlp', label: 'Download content…' }] : []),
    // #177: the page's video (yt-dlp) or every linked full-size image, into Stash.
    ...(ctx.pageStash ? [
      { id: 'page.stashVideo', label: 'Add video to Stash' },
      { id: 'page.stashGallery', label: 'Add all images to Stash' },
    ] : []),
    { id: 'page.viewSource', label: 'View page source' },
    { id: 'page.inspect', label: 'Inspect element' }
  );

  return tidy(items);
}

module.exports = { build, shorten, MAX_LABEL };
