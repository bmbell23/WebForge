// #315: how the macOS app updates while it's unsigned.
//
// electron-updater on macOS hands the download to Squirrel.Mac, and Squirrel
// refuses to install an update that isn't signed with a Developer ID. We don't
// have one (#269), so on darwin the app only *checks* :8012/mac/latest-mac.yml
// (served by webforge_macmirror) and, when it lists a newer version, offers to
// open the .dmg for this Mac's chip in the system browser. Windows is untouched.
//
// Electron-free on purpose (see CLAUDE.md): tests: node windows/macupdate.test.js

// Must match build.mac.publish.url in package.json (the test checks).
const MAC_FEED = 'http://100.69.184.113:8012/mac';

// True where updates are announced and downloaded by hand instead of installed.
function isManual(platform) {
  return platform === 'darwin';
}

// The .dmg in a latest-mac.yml files[] list for this arch (process.arch:
// 'arm64' or 'x64'), else any .dmg, else null. Names follow artifactName
// WebForge-${version}-${arch}.${ext}.
function pickDmg(files, arch) {
  const dmgs = (files || []).map((f) => f && f.url).filter((u) => typeof u === 'string' && u.endsWith('.dmg'));
  return dmgs.find((u) => u.endsWith(`-${arch}.dmg`)) || dmgs[0] || null;
}

// Full download URL for the update in electron-updater's UpdateInfo, or null.
function dmgUrl(info, arch, feed = MAC_FEED) {
  const name = pickDmg(info && info.files, arch);
  return name ? `${feed}/${encodeURIComponent(name)}` : null;
}

module.exports = { MAC_FEED, isManual, pickDmg, dmgUrl };
