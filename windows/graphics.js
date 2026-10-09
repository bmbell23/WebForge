// #317: should WebForge launch with --disable-direct-composition?
//
// #238 made it the default to stop Outlook flashing white on Brandon's PC. That
// left Chromium compositing in software there (log: gpu_compositing
// disabled_software), and #317 traced Alt+Tab piling up ghost "WebForge" tiles to
// the same setup: the Microsoft reports of fullscreen Chromium windows
// multiplying in Alt+Tab were fixed by turning graphics acceleration back on.
// Outlook kept flickering anyway (#291). So the switch is now opt-in: only an
// explicit "Flicker fix on" (directComposition === false) applies it.
//
// Electron-free, so the rule is unit-testable without a Windows machine.

function disableDirectComposition(settings) {
  return Boolean(settings) && settings.directComposition === false;
}

module.exports = { disableDirectComposition };
