# WebForge

A personal daily-driver web browser for **Windows** (installed `.exe`) and
**Android** (installed `.apk`), self-hosted on dockerhost over Tailscale. No app
stores, no accounts, no telemetry.

Nothing here is a fork. Each platform consumes a maintained browser engine as a
dependency — Electron on Windows, the Android System WebView on the phone — so
"following upstream" is a version bump we make deliberately, not a permanent
merge burden.

> **Work is tracked in GitHub Issues and on [Project #9](https://github.com/users/bmbell23/projects/9), never in markdown files.**
> Read `CLAUDE.md` before doing anything — it defines the ticket flow, what
> requires permission, and what must never be done on this server.

---

## Repo map

```
android/     Native Kotlin shell over Android System WebView. Zero third-party deps.
windows/     Electron app: BaseWindow + one WebContentsView per tab.
shared/      about.json — the About page content, rendered by BOTH apps.
server/      sync.py — stdlib-only last-write-wins JSON store (:8013).
scripts/     build-apk.sh, build-windows.sh — build AND stage into releases/.
releases/    Served by nginx on :8012. Installed apps update themselves from here.
data/        Sync service state (gitignored — a bind mount the container holds open).
version.txt  Single source of truth for the version of both apps.
```

### Windows (`windows/`)

| File | Role |
|---|---|
| `main.js` | Everything: tabs, Personas, hotkeys, sync, IPC, session. The core. |
| `personas.js` | Persona store + URL matching (prefix / glob / regex). |
| `hotkeys.js` | Per-Persona key→URL bindings behind the Ctrl+Space leader. |
| `bookmarks.js` / `credentials.js` / `vault.js` | Bookmarks, saved logins, AES-256-GCM vault. |
| `errorlog.js` | Crash/error capture surfaced in Settings → Diagnostics. |
| `ui/` | Chrome UI (`index.html`) plus internal pages loaded as real tabs. |
| `internal-preload.js` / `content-preload.js` | Privileged bridge for our pages; web content never gets it. |

### Android (`android/app/src/main/java/com/webforge/browser/`)

`MainActivity.kt` (tabs, panels, gestures), `Personas.kt`, `BookmarkStore.kt`,
`TabSync.kt`, `Prefs.kt`, `CrashLog.kt`, `UpdateManager.kt`. The Persona
matching and tab-sync fact model are deliberate ports of the Windows semantics —
**when you change one side, change the other.**

---

## Building and releasing

Both scripts build *and* stage into `releases/`, which is what installed apps
poll. There is no separate publish step.

```bash
./scripts/build-apk.sh            # → releases/webforge.apk + version.txt
./scripts/build-windows.sh        # → releases/windows/*.exe + latest.yml
```

**Bump `version.txt` before building, or nothing will update** — both apps
compare against the served version, so rebuilding at the same number is a no-op
on the device.

- The Windows installer is cross-built on Linux inside the
  `electronuserland/builder:wine` image (wine is needed only to stamp exe
  metadata). `node_modules` is host-installed; run `npm install` in `windows/`
  first.
- The version reaches electron-builder via `-c.extraMetadata.version=$VERSION`,
  **not** `npm version` — that left the repo permanently dirty and swept stray
  changes into the next ticket's commit. `windows/package.json`'s own `version`
  field is therefore stale by design; ignore it.
- `electron-builder`'s `files` list is globbed (`*.js`, `ui/**`, `../shared`).
  It was once an explicit allowlist, which shipped a build missing
  `personas.js` and bricked startup before the updater could rescue it (#65).
  **If you add a top-level module, confirm it is inside `app.asar`.**
- Android debug builds are signed with the shared `~/.android/debug.keystore`,
  so installs are in-place upgrades — no uninstall, no data loss.

### Committing

`version.txt` + the `gvc` shell function. **Only commit when the user marks a
ticket Done.**

```bash
gvc "message"              # bumps patch, commits, tags, pushes
gvc 0.1.86 "message"       # explicit version — use this if you already built
                           # and staged artifacts at that number, or the tag
                           # won't match what devices are running
```

---

## How it runs

```bash
docker compose up -d        # v2 — `docker-compose` (v1) is NOT installed here
                            # never `down` on this host — see CLAUDE.md
```

| Service | Port | Purpose |
|---|---|---|
| `webforge_releases` | 8012 | nginx serving `./releases` — `/version.txt`, `/webforge.apk`, `/windows/latest.yml` |
| `webforge_sync` | 8013 | `sync.py` — last-write-wins JSON store |

Reachable at `http://100.69.184.113:<port>` over Tailscale. **From the server
itself, curl `localhost`** — curling the Tailscale IP from the host times out.

### Sync service

`GET`/`PUT /store/<key>` where key ∈ `bookmarks`, `personas`, `tabs`. Each
record is `{"data": …, "updatedAt": <ms>}`; the server keeps whatever it is
given and clients resolve conflicts by comparing `updatedAt`.

**Offline-first is a hard requirement.** Every client renders its local copy and
syncs opportunistically with a 5s timeout; being off the tailnet must never
block or lose anything. Credentials are deliberately *not* synced — that needs
end-to-end encryption first.

**Tabs sync as per-URL facts, not snapshots** (#57): each device publishes when
it opened a URL and when it closed one, and a URL is open iff its open stamp
beats every tombstone for it. A snapshot cannot tell "closed on the other
device" apart from "opened here while that device was offline"; facts reconcile
correctly after either device has been away. Tombstones expire after 30 days.

---

## The browser itself

- **Personas** — named workspaces (Personal, Work, …) with URL rules that
  auto-route tabs. Rules and tab groups share one matcher: prefix, glob (`*`),
  or regex (`/…/`), anchored at the start and open-ended at the end. URLs no
  rule claims land in the built-in **Unassigned** Persona, so the real ones stay
  clean. Definitions sync; which Persona is showing is per-device.
- **Ctrl+Space leader** — then a key. Digits switch Persona; letters jump to
  that Persona's bound URL. Bindings are per-Persona, so `mod-g` means one thing
  in Work and another in Personal. Bare single keys were tried first and were
  far too fragile.
- **Tab mirroring** — close a tab on one device and it closes on the other,
  except the tab you are literally looking at, plus pinned and hotkey tabs,
  which resurrect instead.
- **Vault** (Windows) — master password → scrypt (N=2^15) → AES-256-GCM. The key
  exists only in memory while unlocked.

---

## Things that will bite you

- **`window.prompt()` is unimplemented in Electron** and silently returns null.
  Use inline editors; never `prompt()`.
- **Menu accelerators are unreliable on Windows.** Keyboard chords go through
  `before-input-event`; the Ctrl+Space leader uses `globalShortcut`, registered
  on focus and released on blur.
- **A thrown error in the chrome renderer kills the whole UI script** — tab
  list, bookmarks, settings all vanish at once (#66). Guard optional elements.
- **Never `git stash -u` here.** It deletes the untracked `data/` directory out
  from under the running sync container, leaving a dead bind mount and silently
  failing pushes.
- **Verify before claiming.** Grep for the thing you removed, curl the endpoint,
  show the build output. Reporting work as done when it wasn't is the single
  fastest way to destroy trust in this project (#92).
