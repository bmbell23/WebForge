// #41: hotkey firing moved out of here. Bare-key capture in the page misfired
// while typing and never ran inside iframes; hotkeys now fire from the
// Ctrl+Space leader chord handled in the main process (before-input-event),
// which sees every view and every frame. This preload is kept as the anchor
// for future page-side integrations.
