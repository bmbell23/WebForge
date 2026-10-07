// #317: the OS window title. Windows 11's Alt+Tab kept a ghost tile for old
// titles of our one fullscreen window, and we were changing the title on every
// sidebar push. In fullscreen the title bar is never visible, so the title is
// held at plain "WebForge" there; windowed, it follows the active tab.
function windowTitle({ fullscreen, locked, pageTitle }) {
  if (fullscreen) return 'WebForge';
  if (locked) return 'WebForge — locked';
  return pageTitle ? `${pageTitle} — WebForge` : 'WebForge';
}

// Only touch the OS title when it actually changes.
function makeTitleSetter(setTitle) {
  let last = null;
  return (title) => {
    if (title === last) return false;
    last = title;
    setTitle(title);
    return true;
  };
}

module.exports = { windowTitle, makeTitleSetter };
