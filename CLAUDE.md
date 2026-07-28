# Working rules for this repo (WebForge)

WebForge is a custom web browser app targeting **Windows (installed .exe)** and
**Android (installed APK)**, built on top of an existing browser engine
(Chromium or similar) tracked as an upstream we can pull updates from.

## GitHub Issues are the source of truth
- **Plans, scoping, next-steps, and status live in GitHub Issues — not in local
  markdown files.** Before starting work, read the open issues
  (`gh issue list`) and treat them as the canonical backlog. When you produce a
  plan or scope, put it **in a GitHub issue** (create one or comment on the
  relevant story), not in a `docs/*.md` file.
- Do **not** create standalone planning/tracking `.md` files. If a design needs
  to be written down, it goes in an issue. (Code/architecture docs, ops
  runbooks, and provenance notes may stay as repo docs — but anything that
  tracks *work to be done* belongs in an issue.)
- Keep issues current: when you finish something, comment/close; when scope
  changes, edit the issue. The issues — not memory, not docs — are what the next
  session should trust.
- **Every issue is tagged `STORY:` or `BUG:`** (`BUG:` for defects, `STORY:`
  for everything else — features, chores, refactors, tech-debt). This goes in
  **three places, kept in sync**: (1) the **title** starts with `BUG:`/`STORY:`,
  (2) the **description** starts with `BUG:`/`STORY:`, and (3) a **`bug` or
  `story` label** is applied accordingly. Do this on every new ticket and keep it
  consistent on edits. (Descriptive labels like `enhancement`/`tech-debt` may
  stay alongside the `story` label.)

## ONE ticket at a time, through the board in order

The board is Project #9 "WebForge" (https://github.com/users/bmbell23/projects/9).
Statuses in order: **Scoping → Ready to Implement → In progress → In Review → Done.**
Never skip columns; keep Status current as work moves.

**No work without a GitHub issue.** When the user asks for something, **create the
ticket as soon as possible** — before touching code.

**New ticket lands in Scoping or Ready to Implement:**
- **Straightforward + you can scope it confidently** (clear tasks, acceptance,
  files/approach, no open decisions) → put it **straight into Ready to Implement**.
- **Needs clarifying questions** → leave it in **Scoping**, **tell the user it needs
  clarification, and ask the questions**. Resolve them with the user, then promote to
  Ready to Implement. Never build from a guess.

**Start implementing → In progress.**

**Made ANY code change → move to In Review, and SAY SO.** The moment you edit code,
move the ticket to **In Review** and **tell the user it's in review**.

**The code stays UNCOMMITTED while In Review.** Do **not** commit when you move to
Review. In Review means: work done, **not yet committed**, awaiting the user's verdict.
The commit happens only when the ticket is decided **Done** — or the ticket goes back
to **In progress** for more changes.

**Builds are always explicit — never leave the user guessing.** If a change needs an
**APK rebuild** or a **Windows installer rebuild** to be testable/live, **say so plainly
and ask**: *"this needs a `<APK/installer>` rebuild to see it — want me to run it, or
will you?"* If they say you, run it. If they'll do it, wait. If the user would ever have
to *discover on their own* that a rebuild was required, you failed to tell them — that's
a bug in the process.

**UNCOMMITTED == the ACTIVE In-Review ticket.** Uncommitted changes should match the
**one ticket you're actively reviewing** (just built, not yet blessed). State both
clearly. Exception: a committed **"watch" ticket** that's still In Review (see below) is
committed, so it isn't in the uncommitted list — that's fine.

**Only ONE ACTIVE ticket in In progress + In Review at a time.** The active lane holds
exactly one thing you're building. **Committed "watch" tickets left in In Review don't
count** against this. Scoping, Ready to Implement, and Done may hold many.

**"Watch" tickets may stay in In Review after commit.** Sometimes the user reviews a
change, it gets committed, but they want to keep the ticket in **In Review to watch how
it behaves over time** before marking Done. That's allowed and expected: such a ticket
is **committed** and **passive** — it does NOT count as active work and isn't in the
uncommitted list. It just waits in Review under the user's eye until they decide Done.

**Remind the user of In-Review tickets every cycle.** Whenever we transition between
tasks — finish one, start another, or the user pivots — **list the tickets currently
sitting in In Review** so they stay visible and the user can close them when ready.
Never let them silently pile up.

**User pivots to a new topic while an ACTIVE (uncommitted) ticket is in In Review? STOP
— do not start the new thing.** Say: to pick that up, we first need to close out the
in-review ticket — *is it good to mark Done and commit?* Resolve it (Done + commit, or
back to In progress) first. **Even "just do this real quick" waits.** (Passive committed
"watch" tickets don't block a pivot — only the active/uncommitted one does.)

**Done = the user blesses it.** Only the **user** marks a ticket Done. On that bless,
**then commit** (via `gvc`, still a gated action) if not already committed, and the
active lane is clear for the next ticket.

**Update tickets + comment profusely** as work moves — scope, findings, decisions, what
was built, why. The issues (not memory, not docs) are what the next session trusts.

## Autonomy & permissions
- **Work freely without asking for routine, reversible steps** — as long as the
  ticket process above is followed (every change has an issue, work moves to **In
  Review** as soon as code changes) and changes go through code review. Don't
  stop to ask permission to:
  - change directories / `cd` around the repo,
  - read, edit, or create code and other files,
  - run read-only / inspection commands (greps, `curl` health checks, linters,
    `node --check`, etc.).
- **Always ask the user first before these gated actions:**
  1. **Building/publishing app artifacts** — building the **APK**, building the
     **Windows installer/.exe**, or publishing a release/update that installed
     apps will pick up. Ask before building/publishing, and always **tell the
     user when a rebuild is needed** so they never have to discover it themselves.
     Once they say go, run it yourself; if they'd rather do it, wait.
  2. **Committing code** — `git commit`, `gvc`, `git push`. Commits go through `gvc`,
     only with explicit permission, and **only when a ticket is decided Done** —
     In-Review work stays uncommitted (see the board flow above).
  3. **Anything destructive or hard to reverse** — deleting branches/tags/releases,
     force-pushes, rewriting upstream tracking configuration.

## Architecture & upstream engine tracking (decided in #1, 2026-07-27)
- **Windows**: **Electron** app in `windows/` — bundles Chromium; browser tabs
  via WebContentsView; `electron-builder` produces an NSIS `.exe` installer
  (cross-built from this Linux server); `electron-updater` (generic HTTP
  provider) auto-updates from dockerhost. **Following upstream = bumping the
  Electron version** — Electron tracks Chromium stable within weeks; update it
  deliberately, per ticket, like any dependency.
- **Android**: native **Kotlin shell over Android System WebView** in
  `android/` — the GreatReads `simple-app` pattern. The OS keeps the engine
  (WebView) updated via Play; our APK self-updates by checking a version
  endpoint on dockerhost and installing in-place (consistent signing key ⇒
  upgrade, no uninstall). Revisit GeckoView only if WebView control proves
  too limiting.
- **Releases are self-hosted on dockerhost** (Tailscale), same flow as
  GreatReads: staged artifacts + version endpoint; `version.txt` + `gvc` drive
  versions for both platforms.
- Layout: `android/` + `windows/` + `shared/` (shared UI assets/logic) +
  `scripts/` (`build-apk.sh`, `build-windows.sh`, `publish-release.sh`).

## Versioning
- `version.txt` + the `gvc` shell function (bumps patch, commits `vX.Y.Z: msg`,
  tags, pushes). Don't commit/push without being asked.
- Secrets: `.env` (gitignored) from a committed `.env.example`. Never commit
  real keys/tokens.
