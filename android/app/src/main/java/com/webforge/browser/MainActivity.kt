package com.webforge.browser

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView

class Tab(val id: Int, val webView: WebView) {
    var pinned = false
    var quick = false // #54: quick-launch (the phone's answer to hotkey tabs)
    var lastActiveAt = System.currentTimeMillis() // #79: for inactivity expiry
    var openedAt = System.currentTimeMillis()     // #57: when this tab was opened here
    var pendingUrl: String? = null   // #93: adopted from another device, not loaded yet
    var pendingTitle: String? = null
    var folder = ""      // #86: manual grouping, set in tab edit mode
    var persona = Personas.UNASSIGNED // #88
    var label: String? = null // #86: user-given name overriding the page title
    val title: String get() = label ?: pendingTitle ?: webView.title?.takeIf { it.isNotBlank() } ?: url
    val url: String get() = pendingUrl ?: webView.url ?: "about:blank"
}

class MainActivity : Activity() {

    companion object {
        private const val START_URL = "https://www.google.com/"
    }

    private lateinit var webContainer: FrameLayout
    private lateinit var overlay: FrameLayout
    private lateinit var urlBar: EditText
    private lateinit var tabsBtn: TextView
    private lateinit var progress: ProgressBar

    private val tabs = ArrayList<Tab>()
    private var activeIndex = 0
    private var urlEditing = false // #64: real focus state, not a latched flag
    private val sweepHandler = android.os.Handler(android.os.Looper.getMainLooper()) // #79
    private var bmEditMode = false // #89: long-press a BOOKMARK to organize
    private var pendingBmFolder: String? = null // #89: created, awaiting its first bookmark
    private val bmExpanded = mutableSetOf<String>() // #91: folders survive a re-render
    private var currentScroll: ScrollView? = null   // #91: so does scroll position
    private var pendingScrollY = 0
    private var currentPanel: String? = null // #95
    private var nextTabId = 1
    private var findOpen = false // #101: find in page

    private val active: Tab? get() = tabs.getOrNull(activeIndex)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CrashLog.install(applicationContext) // #60: capture crashes for Settings
        setContentView(R.layout.activity_main)

        webContainer = findViewById(R.id.webContainer)
        overlay = findViewById(R.id.overlay)
        urlBar = findViewById(R.id.urlBar)
        tabsBtn = findViewById(R.id.tabsBtn)
        progress = findViewById(R.id.progress)

        goFullscreen()
        applyInsets()

        urlBar.setOnEditorActionListener { _, actionId, event ->
            val enter = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
            if (actionId == EditorInfo.IME_ACTION_GO || enter) {
                Prefs.resolveInput(this, urlBar.text.toString())?.let { navigate(it) }
                true
            } else false
        }
        urlBar.setOnFocusChangeListener { _, has -> urlEditing = has } // #64
        tabsBtn.setOnClickListener { showTabSheet() }
        findViewById<TextView>(R.id.bookmarksBtn).setOnClickListener { showBookmarks() } // #87
        wireFindBar() // #101

        newTab(START_URL)
        BookmarkStore.sync(this) { }
        Personas.sync(this) { runOnUiThread { rehomeTabs() } } // #88/#96
        syncTabsAcrossDevices() // #57 // warm the cache for the bookmarks panel
        UpdateManager(this).checkForUpdate()
    }

    // --- #101: find in page. The phone has no Ctrl+F, so this is opened from
    // Settings; everything else matches the Windows bar — live search, a match
    // counter, next/previous, and the back gesture closing it first. ---
    private fun wireFindBar() {
        val bar = findViewById<LinearLayout>(R.id.findBar)
        val input = findViewById<EditText>(R.id.findInput)
        val count = findViewById<TextView>(R.id.findCount)

        input.addTextChangedListener(object : android.text.TextWatcher {
            override fun afterTextChanged(s: android.text.Editable?) {
                val q = s?.toString() ?: ""
                if (q.isEmpty()) {
                    active?.webView?.clearMatches()
                    count.text = ""
                } else {
                    active?.webView?.findAllAsync(q)
                }
            }
            override fun beforeTextChanged(cs: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(cs: CharSequence?, a: Int, b: Int, c: Int) {}
        })
        input.setOnEditorActionListener { _, _, _ -> active?.webView?.findNext(true); true }
        findViewById<TextView>(R.id.findPrev).setOnClickListener { active?.webView?.findNext(false) }
        findViewById<TextView>(R.id.findNext).setOnClickListener { active?.webView?.findNext(true) }
        findViewById<TextView>(R.id.findClose).setOnClickListener { closeFind() }
        bar.visibility = View.GONE
    }

    /** Match counts arrive per WebView, from the listener set up in [newTab]. */
    private fun onFindResults(activeMatch: Int, total: Int) {
        if (!findOpen) return
        val count = findViewById<TextView>(R.id.findCount)
        val input = findViewById<EditText>(R.id.findInput)
        count.text = when {
            input.text.isNullOrEmpty() -> ""
            total == 0 -> "0/0"
            else -> "${activeMatch + 1}/$total" // the callback's index is 0-based
        }
    }

    private fun openFind() {
        findOpen = true
        val bar = findViewById<LinearLayout>(R.id.findBar)
        val input = findViewById<EditText>(R.id.findInput)
        bar.visibility = View.VISIBLE
        input.requestFocus()
        input.selectAll()
        (getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager)
            .showSoftInput(input, 0)
        if (input.text.isNotEmpty()) active?.webView?.findAllAsync(input.text.toString())
    }

    private fun closeFind() {
        if (!findOpen) return
        findOpen = false
        val bar = findViewById<LinearLayout>(R.id.findBar)
        val input = findViewById<EditText>(R.id.findInput)
        active?.webView?.clearMatches()
        bar.visibility = View.GONE
        findViewById<TextView>(R.id.findCount).text = ""
        (getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager)
            .hideSoftInputFromWindow(input.windowToken, 0)
        goFullscreen() // the keyboard leaving can bring the system bars back
    }

    // --- #58: status bar VISIBLE above our bar; navigation bar hidden ------
    private fun goFullscreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false) // we position around insets
            window.insetsController?.apply {
                // #85: navigation bar STAYS — the user needs the gesture pill to
                // swipe out of the app. We draw edge-to-edge and pad around both
                // bars instead of hiding them.
                setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS)
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION // #85: bars stay visible
        }
        // #60: with decorFitsSystemWindows(false) Android paints a translucent
        // CONTRAST SCRIM behind the status bar — that's the "gray" over our
        // black strip. Turn it off and make the bar itself transparent so our
        // own padding colour is what shows.
        @Suppress("DEPRECATION")
        window.statusBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }
        // Draw behind the cutout, then pad for it below so the bar clears the
        // camera instead of hiding under it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }

    /** Pad the top strip to the real status-bar/cutout height (#58). */
    private fun applyInsets() {
        val root = findViewById<View>(R.id.root)
        root.setOnApplyWindowInsetsListener { v, insets ->
            val top = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bars = insets.getInsets(WindowInsets.Type.statusBars())
                val cutout = insets.getInsets(WindowInsets.Type.displayCutout())
                maxOf(bars.top, cutout.top)
            } else {
                @Suppress("DEPRECATION")
                insets.systemWindowInsetTop
            }
            // #60: the raw inset sat too tall; 75% still clears the icons and
            // the camera on the user's device.
            val padded = (top * 0.75f).toInt()
            findViewById<View>(R.id.statusSpacer).layoutParams =
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, padded)
            // #85: keep the page clear of the navigation pill.
            val bottom = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                insets.getInsets(WindowInsets.Type.navigationBars()).bottom
            } else {
                @Suppress("DEPRECATION")
                insets.systemWindowInsetBottom
            }
            findViewById<View>(R.id.webContainer).setPadding(0, 0, 0, bottom)
            // Panels must clear the status bar too.
            overlay.setPadding(0, padded, 0, bottom)
            insets
        }
        root.requestApplyInsets()
    }

    // #85: see every touch before children consume it, so a panel swipe works
    // even over a scrolling list.
    override fun dispatchTouchEvent(ev: android.view.MotionEvent): Boolean {
        if (overlay.visibility == View.VISIBLE) panelSwipe.onTouchEvent(ev)
        else pageSwipe.onTouchEvent(ev) // #92: pull-to-reload on the page
        return super.dispatchTouchEvent(ev)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goFullscreen() // the bars creep back after IME/task switch
    }

    // --- tabs ---------------------------------------------------------------
    @SuppressLint("SetJavaScriptEnabled")
    private fun newTab(url: String?, background: Boolean = false, lazy: Boolean = false): Tab {
        val wv = WebView(this)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            // Self-hosted services are often plain HTTP behind an HTTPS page.
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        // #101: find-in-page counts come back here. Only the visible tab's may
        // reach the bar — a background tab still settling would clobber the
        // count you are reading.
        wv.setFindListener { activeMatch, total, isDoneCounting ->
            if (isDoneCounting && wv === active?.webView) onFindResults(activeMatch, total)
        }
        val tab = Tab(nextTabId++, wv)
        // #96: URL rules decide the Persona at creation, so tabs never sit in
        // Unassigned waiting to be clicked.
        tab.persona = Personas.forUrl(this, url ?: "")
        // #95: this URL is open again — drop any tombstone, or we would keep
        // publishing "closed" for a tab that is plainly sitting right here.
        url?.let { TabSync.forgetClose(it) }

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                // Quick-launch tabs are sticky like Windows hotkey tabs: they
                // only ever show their own site, links open elsewhere (#54).
                if (tab.quick) {
                    newTab(req.url.toString())
                    return true
                }
                return false
            }

            // Self-hosted HTTPS usually means a self-signed cert; WebView
            // cancels by default and shows a blank page. Ask instead.
            override fun onReceivedSslError(
                view: WebView,
                handler: SslErrorHandler,
                error: SslError
            ) {
                android.app.AlertDialog.Builder(this@MainActivity)
                    .setTitle("Certificate not trusted")
                    .setMessage(
                        "${error.url}\n\nThis site's certificate isn't trusted " +
                            "(self-signed or expired). Continue anyway?"
                    )
                    .setPositiveButton("Continue") { _, _ -> handler.proceed() }
                    .setNegativeButton("Cancel") { _, _ -> handler.cancel() }
                    .setOnCancelListener { handler.cancel() }
                    .show()
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                if (tab === active) syncChrome()
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (tab === active) syncChrome()
            }

            // #64: pushState/replaceState navigation fires NEITHER onPageStarted
            // nor onPageFinished, so on any SPA the address bar never updated
            // after the first load. This hook does fire for in-page history.
            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                // #88: follow the URL into whichever Persona claims it.
                val claimed = Personas.forUrl(this@MainActivity, url)
                if (claimed != Personas.UNASSIGNED && claimed != tab.persona) {
                    tab.persona = claimed
                    if (tab === active) Personas.setActive(this@MainActivity, claimed)
                }
                if (tab === active) syncChrome()
                super.doUpdateVisitedHistory(view, url, isReload)
            }

            // #60: if a renderer dies (OOM with several tabs alive, or a page
            // taking it down) the OS default is to kill the WHOLE APP. Handle
            // it: drop the dead view, put a live one in its place, stay up.
            override fun onRenderProcessGone(
                view: WebView,
                detail: RenderProcessGoneDetail?
            ): Boolean {
                val idx = tabs.indexOf(tab)
                val lastUrl = tab.url
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                if (idx >= 0) tabs.removeAt(idx)
                runOnUiThread {
                    android.widget.Toast
                        .makeText(this@MainActivity, "Tab reloaded (renderer restarted)", android.widget.Toast.LENGTH_SHORT)
                        .show()
                    if (tabs.isEmpty()) newTab(lastUrl)
                    else {
                        activeIndex = activeIndex.coerceAtMost(tabs.size - 1)
                        activateTab(activeIndex)
                    }
                }
                return true // handled — do NOT kill the process
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                if (tab !== active) return
                progress.progress = newProgress
                progress.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
            }

            override fun onReceivedTitle(view: WebView, title: String) {
                if (tab === active) syncChrome()
            }

            // #59: with setSupportMultipleWindows(true) and NO handler here,
            // WebView silently DROPS every target=_blank / window.open link —
            // which is why links to self-hosted services did nothing.
            override fun onCreateWindow(
                view: WebView,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message
            ): Boolean {
                val opened = newTab(null) // must be unloaded for the transport
                val transport = resultMsg.obj as WebView.WebViewTransport
                transport.webView = opened.webView
                resultMsg.sendToTarget()
                return true
            }
        }

        tabs.add(tab)
        // url == null means "hand this to a window transport" — WebView
        // requires such a view to have had NO content loaded yet (#60).
        if (url != null) wv.loadUrl(url)
        if (!background) activateTab(tabs.size - 1) else syncChrome()
        return tab
    }

    private fun activateTab(index: Int) {
        if (index !in tabs.indices) return
        // #101: close the bar before activeIndex moves, so clearMatches lands on
        // the tab that was actually searched and its highlights don't linger.
        if (findOpen) closeFind()
        activeIndex = index
        tabs[index].pendingUrl?.let { u -> // #93: adopted tab loads when opened
            tabs[index].pendingUrl = null
            tabs[index].pendingTitle = null
            tabs[index].webView.loadUrl(u)
        }
        tabs[index].lastActiveAt = System.currentTimeMillis() // #79
        Personas.setActive(this, tabs[index].persona) // #88
        webContainer.removeAllViews()
        val wv = tabs[index].webView
        (wv.parent as? ViewGroup)?.removeView(wv)
        webContainer.addView(
            wv,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        syncChrome()
    }

    private fun closeTab(index: Int, remote: Boolean = false) {
        val tab = tabs.getOrNull(index) ?: return
        if (tab.pinned) return
        if (!remote) TabSync.recordClose(tab.url) // #57: tell the other devices
        // #79: only follow the close if it was the tab you were ON. This
        // unconditionally re-activated, so closing a background tab (or the
        // idle sweep closing several) yanked you to a different page.
        val wasActive = index == activeIndex
        tabs.removeAt(index)
        (tab.webView.parent as? ViewGroup)?.removeView(tab.webView)
        tab.webView.destroy()
        if (tabs.isEmpty()) {
            newTab(START_URL)
            return
        }
        if (wasActive) {
            activateTab(index.coerceAtMost(tabs.size - 1))
        } else {
            if (index < activeIndex) activeIndex--  // keep pointing at the same tab
            syncChrome()
        }
    }

    // #79: close normal tabs untouched for too long. Pinned and quick-launch
    // tabs are exempt, as is whichever tab is open, and the last tab standing.
    // #57: publish this device's tabs per Persona and pick up the others'.
    private fun syncTabsAcrossDevices() {
        // #57: publish facts (url, title, opened-at) rather than a snapshot.
        val local = HashMap<String, MutableList<Triple<String, String, Long>>>()
        for (t in tabs) {
            val u = t.url
            if (u.isBlank() || u == "about:blank") continue
            local.getOrPut(t.persona) { mutableListOf() }.add(Triple(u, t.title, t.openedAt))
        }
        TabSync.sync(this, local) {
            runOnUiThread {
                val before = tabs.size
                applyRemoteTabState()
                // #95: if the tab menu is open, show what just arrived — without
                // this you'd sit staring at a stale list waiting for a re-open.
                if (currentPanel == "tabs" && tabs.size != before) {
                    pendingScrollY = currentScroll?.scrollY ?: 0
                    showTabSheet()
                }
            }
        }
    }

    /**
     * #57: a URL is open iff its open stamp beats its tombstone. Never closes
     * the tab you're on (that one gets resurrected instead), nor pinned or
     * quick-launch tabs.
     */
    private fun applyRemoteTabState() {
        val doomed = mutableListOf<Int>()
        for (i in tabs.indices) {
            val t = tabs[i]
            // #95: tombstones from every Persona and every device, ours included.
            // Scoping this to the active Persona meant a tab in any other one
            // could never be closed remotely. (#94: no tombstones at all is the
            // NORMAL case — never bail out here.)
            val closedAt = TabSync.closedAt(t.url)
            if (closedAt <= t.openedAt) continue
            if (i == activeIndex || t.pinned || t.quick) {
                t.openedAt = System.currentTimeMillis() // resurrect and republish
                continue
            }
            doomed.add(i)
        }
        if (doomed.isNotEmpty() && doomed.size < tabs.size) {
            for (i in doomed.sortedDescending()) closeTab(i, remote = true)
        }

        // #94: adopt across EVERY Persona, not just the active one — otherwise
        // the desktop's other workspaces never appear. A Persona id this device
        // doesn't know yet (definitions still converging) falls back to
        // Unassigned so the tabs are at least visible rather than silently lost.
        val known = Personas.all(this).map { it.id }.toSet()
        val me = TabSync.deviceId(this)
        for ((remotePid, open) in TabSync.mergedOpen) {
            val target = if (remotePid in known) remotePid else Personas.UNASSIGNED
            for ((url, info) in open) {
                val (title, at, dev) = info
                if (dev == me) continue                  // #95: our own echo
                if (TabSync.closedAt(url) > at) continue // closed more recently anywhere
                if (tabs.any { it.url == url }) continue // already have it
                val t = newTab(url, background = true, lazy = true)
                // #96: match locally first — don't trust the other device's
                // persona id, which may not have converged yet.
                val local = Personas.forUrl(this, url)
                t.persona = if (local != Personas.UNASSIGNED) local else target
                t.openedAt = at
                t.pendingTitle = title
            }
        }
        syncChrome()
    }

    // #92: pull down on a page to reload — replaces the Reload menu action.
    private val pageSwipe by lazy {
        android.view.GestureDetector(this, object : android.view.GestureDetector.SimpleOnGestureListener() {
            override fun onFling(
                e1: android.view.MotionEvent?,
                e2: android.view.MotionEvent,
                vx: Float,
                vy: Float
            ): Boolean {
                val start = e1 ?: return false
                val dy = e2.y - start.y
                val dx = e2.x - start.x
                // Only when the page is already at the top, so it can't fight scrolling.
                val atTop = (active?.webView?.scrollY ?: 1) == 0
                if (atTop && dy > dp(120) && kotlin.math.abs(dy) > kotlin.math.abs(dx) * 2 && vy > 0) {
                    active?.webView?.reload()
                    android.widget.Toast
                        .makeText(this@MainActivity, "Reloading…", android.widget.Toast.LENGTH_SHORT).show()
                    return true
                }
                return false
            }
        })
    }

    /** #96: re-file tabs whose Persona rules have since changed or arrived. */
    private fun rehomeTabs() {
        var changed = false
        for (t in tabs) {
            val claimed = Personas.forUrl(this, t.url)
            if (claimed != Personas.UNASSIGNED && claimed != t.persona) {
                t.persona = claimed
                changed = true
            }
        }
        if (changed) syncChrome()
    }

    private fun sweepStaleTabs() {
        val hours = Prefs.expiryHours(this)
        if (hours <= 0) return
        val cutoff = System.currentTimeMillis() - hours * 3600_000L
        val doomed = tabs.indices.filter { i ->
            i != activeIndex && !tabs[i].pinned && !tabs[i].quick && tabs[i].lastActiveAt < cutoff
        }
        if (doomed.isEmpty() || doomed.size >= tabs.size) return
        // Remove from the end so earlier indices stay valid.
        for (i in doomed.sortedDescending()) closeTab(i)
    }

    private fun navigate(url: String) {
        urlEditing = false
        urlBar.clearFocus()
        hideKeyboard()
        (active ?: newTab(url).also { return }).webView.loadUrl(url)
    }

    private fun syncChrome() {
        val t = active ?: return
        if (!urlEditing) urlBar.setText(if (t.url == "about:blank") "" else t.url)
        tabsBtn.text = tabs.count { it.persona == Personas.activeId(this) }.toString() // #93
    }

    private fun hideKeyboard() {
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager)
            .hideSoftInputFromWindow(urlBar.windowToken, 0)
    }

    // --- overlay panels ------------------------------------------------------
    // #84: panels dismiss with a horizontal swipe, the way Android users expect,
    // rather than requiring the Close row at the bottom.
    private val panelSwipe by lazy {
        android.view.GestureDetector(this, object : android.view.GestureDetector.SimpleOnGestureListener() {
            override fun onFling(
                e1: android.view.MotionEvent?,
                e2: android.view.MotionEvent,
                vx: Float,
                vy: Float
            ): Boolean {
                val start = e1 ?: return false
                val dx = e2.x - start.x
                val dy = e2.y - start.y
                // Mostly-horizontal, decisive, and to the right = dismiss.
                if (dx > dp(70) && kotlin.math.abs(dx) > kotlin.math.abs(dy) * 2 && vx > 0) {
                    closePanel()
                    return true
                }
                return false
            }
        })
    }

    /** #99: the bookmarks panel is throwaway UI — leaving it drops edit mode and
     *  every expanded folder, so the next visit starts clean. (Its search box is
     *  rebuilt empty on each [showBookmarks], so there is no query to clear.) */
    private fun resetBookmarkUi() {
        bmEditMode = false
        bmExpanded.clear()
    }

    /** [panel] names the section this screen belongs to; screens inside the same
     *  section keep each other's state, moving between sections resets it (#99). */
    private fun openPanel(panel: String? = null, build: (LinearLayout) -> Unit) {
        if (panel != "bookmarks") resetBookmarkUi() // #99
        currentPanel = panel
        val scroll = ScrollView(this)
        currentScroll = scroll // #91
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(6), dp(16), dp(28)) // #89: header lines up with the top bar
        }
        build(col)
        scroll.addView(col)
        overlay.removeAllViews()
        overlay.addView(scroll)
        overlay.visibility = View.VISIBLE
        if (pendingScrollY > 0) { // #91: land where we were, not at the top
            val y = pendingScrollY
            pendingScrollY = 0
            scroll.post { scroll.scrollTo(0, y) }
        }
        // #85: the swipe listener used to live here, but the panel's ScrollView
        // is a child and swallowed the gesture. Handled in dispatchTouchEvent.
    }

    private fun closePanel() {
        currentPanel = null // #95
        resetBookmarkUi() // #99
        overlay.visibility = View.GONE
        overlay.removeAllViews()
        goFullscreen()
    }

    // #84: card + pill helpers so panels read like a real settings screen
    // rather than a flat list of tappable strings.
    private fun card(col: LinearLayout): LinearLayout {
        val c = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.card_bg)
            setPadding(dp(4), dp(4), dp(4), dp(4))
        }
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        )
        lp.bottomMargin = dp(14)
        col.addView(c, lp)
        return c
    }

    /** #87: title with a right-aligned action, so Settings lands in the same
     *  screen position as the bookmarks button — double-tap that spot. */
    private fun titleWithAction(col: LinearLayout, text: String, glyph: String, onAction: () -> Unit) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        row.addView(TextView(this).apply {
            this.text = text
            setTextColor(0xFFE8E8EA.toInt())
            textSize = 26f
            setPadding(dp(4), 0, 0, dp(4))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        row.addView(TextView(this).apply {
            this.text = glyph
            setTextColor(0xFFE8E8EA.toInt())
            textSize = 19f
            setPadding(dp(12), dp(4), dp(6), dp(4))
            setOnClickListener { onAction() }
        })
        col.addView(row)
    }

    private fun title(col: LinearLayout, text: String) {
        col.addView(TextView(this).apply {
            this.text = text
            setTextColor(0xFFE8E8EA.toInt())
            textSize = 26f
            setPadding(dp(4), 0, 0, dp(4))
        })
    }

    private fun caption(col: LinearLayout, text: String) {
        col.addView(TextView(this).apply {
            this.text = text
            setTextColor(0xFF7C7C82.toInt())
            textSize = 12.5f
            setPadding(dp(4), 0, dp(4), dp(16))
            setLineSpacing(dp(3).toFloat(), 1f)
        })
    }

    /** A selectable option inside a card: label on the left, tick on the right. */
    private fun option(parent: LinearLayout, label: String, selected: Boolean, onClick: () -> Unit) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(13), dp(14), dp(13))
            isClickable = true
            setOnClickListener { onClick() }
        }
        row.addView(TextView(this).apply {
            text = label
            setTextColor(0xFFE8E8EA.toInt())
            textSize = 15f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        row.addView(TextView(this).apply {
            text = if (selected) "✓" else ""
            setTextColor(0xFF3D9BFF.toInt())
            textSize = 16f
        })
        parent.addView(row)
    }

    /** A tappable action inside a card, with optional supporting text. */
    private fun action(parent: LinearLayout, label: String, sub: String? = null, onClick: () -> Unit) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(13), dp(14), dp(13))
            isClickable = true
            setOnClickListener { onClick() }
        }
        row.addView(TextView(this).apply {
            text = label
            setTextColor(0xFFE8E8EA.toInt())
            textSize = 15f
        })
        if (sub != null) {
            row.addView(TextView(this).apply {
                text = sub
                setTextColor(0xFF7C7C82.toInt())
                textSize = 12f
                setPadding(0, dp(2), 0, 0)
            })
        }
        parent.addView(row)
    }

    private fun header(col: LinearLayout, text: String) {
        col.addView(TextView(this).apply {
            this.text = text
            setTextColor(0xFF7C7C82.toInt())
            textSize = 11f
            setPadding(0, dp(18), 0, dp(8))
        })
    }

    private fun row(col: LinearLayout, text: String, sub: String? = null, onClick: () -> Unit) {
        val line = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(12), 0, dp(12))
            isClickable = true
            setOnClickListener { onClick() }
        }
        line.addView(TextView(this).apply {
            this.text = text
            setTextColor(0xFFE8E8EA.toInt())
            textSize = 16f
        })
        if (sub != null) {
            line.addView(TextView(this).apply {
                this.text = sub
                setTextColor(0xFF7C7C82.toInt())
                textSize = 12f
            })
        }
        col.addView(line)
    }

    // #86: one row per tab. In edit mode it grows a ☰ drag handle and a ✎
    // pencil; otherwise it's a plain tap-to-switch row.
    private fun tabRow(parent: LinearLayout, index: Int, indent: Int) {
        val t = tabs[index]
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8 + indent), dp(11), dp(8), dp(11))
        }

        if (index == activeIndex) row.setBackgroundResource(R.drawable.pill_bg) // #95: selected, not annotated
        row.addView(TextView(this).apply {
            text = t.title
            setTextColor(0xFFE8E8EA.toInt())
            if (index == activeIndex) setTypeface(null, android.graphics.Typeface.BOLD)
            textSize = 15f
            maxLines = 1
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            setOnClickListener { closePanel(); activateTab(index) }
            setOnLongClickListener { showTabEditor(index); true } // #89: rename/pin/file
        })

        if (!t.pinned) {
            row.addView(TextView(this).apply {
                text = "✕"
                setTextColor(0xFF7C7C82.toInt())
                textSize = 16f
                setPadding(dp(14), 0, dp(4), 0)
                setOnClickListener { closePanel(); closeTab(index) }
            })
        }

        parent.addView(row)
    }

    /** #86: move a tab to a new position, optionally re-filing it. */
    private fun moveTab(from: Int, to: Int, folder: String) {
        if (from !in tabs.indices || to !in tabs.indices) return
        // Track the active TAB, not its index: indices shift as we reorder, and
        // resolving them afterwards lands on whichever tab took that slot.
        val activeTab = tabs.getOrNull(activeIndex)
        val moving = tabs[from]
        moving.folder = folder
        tabs.removeAt(from)
        tabs.add(to.coerceIn(0, tabs.size), moving)
        activeIndex = activeTab?.let { tabs.indexOf(it) }?.takeIf { it >= 0 } ?: 0
        showTabSheet()
    }

    private fun showTabSheet(): Unit = openPanel("tabs") { col -> // #95
        syncTabsAcrossDevices() // #95: opening the menu is a refresh
        title(col, "Tabs")
        caption(col, "Tap to switch · long-press to rename or pin · swipe right to go back.")

        // #94: Persona dropdown immediately under the header. Styled explicitly —
        // the stock spinner item renders black-on-grey against our dark chrome.
        val activePersona = Personas.activeId(this)
        val plist = Personas.ordered(this)
        val labels = plist.map { p -> "${p.name}   (${tabs.count { it.persona == p.id }})" }
        val adapter = object : android.widget.ArrayAdapter<String>(
            this, android.R.layout.simple_spinner_item, labels
        ) {
            private fun style(v: View, dropdown: Boolean): View {
                (v as? TextView)?.apply {
                    setTextColor(0xFFE8E8EA.toInt())
                    textSize = 15f
                    if (dropdown) {
                        setBackgroundColor(0xFF131315.toInt())
                        setPadding(dp(16), dp(14), dp(16), dp(14))
                    } else {
                        setPadding(dp(14), dp(6), dp(14), dp(6))
                    }
                }
                return v
            }
            override fun getView(pos: Int, cv: View?, parent: android.view.ViewGroup): View =
                style(super.getView(pos, cv, parent), false)
            override fun getDropDownView(pos: Int, cv: View?, parent: android.view.ViewGroup): View =
                style(super.getDropDownView(pos, cv, parent), true)
        }
        val spinner = android.widget.Spinner(this).apply {
            setBackgroundResource(R.drawable.pill_bg)
            setPopupBackgroundDrawable(android.graphics.drawable.ColorDrawable(0xFF131315.toInt()))
            this.adapter = adapter
            setSelection(plist.indexOfFirst { it.id == activePersona }.coerceAtLeast(0), false)
            onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onItemSelected(a: android.widget.AdapterView<*>?, v: View?, pos: Int, id: Long) {
                    val target = plist.getOrNull(pos) ?: return
                    if (target.id == Personas.activeId(this@MainActivity)) return
                    Personas.setActive(this@MainActivity, target.id)
                    val mine = tabs.indices.filter { tabs[it].persona == target.id }
                    if (mine.isNotEmpty()) {
                        activateTab(mine.maxByOrNull { tabs[it].lastActiveAt } ?: mine.first())
                    } else {
                        newTab(START_URL)
                    }
                    showTabSheet()
                }
                override fun onNothingSelected(a: android.widget.AdapterView<*>?) {}
            }
        }
        col.addView(
            spinner,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44))
                .apply { bottomMargin = dp(14) }
        )

        // #94: a flat list of this Persona's tabs. Quick-launch and pinned float
        // to the top; no folders, no carets, no grouping menus.
        val mine = tabs.indices
            .filter { tabs[it].persona == activePersona }
            .sortedWith(compareBy({ if (tabs[it].quick) 0 else if (tabs[it].pinned) 1 else 2 }, { it }))

        val special = mine.filter { tabs[it].quick || tabs[it].pinned }
        for (i in special) tabRow(col, i, 0)

        // #96: group the rest by host, like the Windows sidebar — a host with
        // two or more tabs gets a header; singletons stay loose.
        val rest = mine.filter { !tabs[it].quick && !tabs[it].pinned }
        fun hostOf(u: String): String = try {
            android.net.Uri.parse(u).host?.removePrefix("www.") ?: ""
        } catch (e: Exception) { "" }
        val buckets = LinkedHashMap<String, MutableList<Int>>()
        for (i in rest) buckets.getOrPut(hostOf(tabs[i].url)) { mutableListOf() }.add(i)
        val loose = mutableListOf<Int>()
        for ((host, idx) in buckets) {
            if (idx.size >= 2 && host.isNotEmpty()) {
                header(col, host.uppercase())
                for (i in idx) tabRow(col, i, 12)
            } else {
                loose.addAll(idx)
            }
        }
        if (loose.isNotEmpty()) {
            if (buckets.size > loose.size) header(col, "OTHER")
            for (i in loose) tabRow(col, i, 0)
        }

        // New tab sits at the BOTTOM and reads like one more tab.
        val addRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8), dp(13), dp(8), dp(13))
            isClickable = true
            setOnClickListener { closePanel(); newTab(START_URL) }
        }
        addRow.addView(TextView(this).apply {
            text = "＋   New tab"
            setTextColor(0xFF7C7C82.toInt())
            textSize = 15f
        })
        col.addView(addRow)
    }

    /** #86: name a new tab folder (never window.prompt — inline, as everywhere). */
    private fun showFolderCreator(): Unit = openPanel("tabs") { col ->
        title(col, "New tab folder")
        val name = EditText(this).apply {
            hint = "Folder name"
            setHintTextColor(0xFF7C7C82.toInt())
            setTextColor(0xFFE8E8EA.toInt())
            setBackgroundResource(R.drawable.pill_bg)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            maxLines = 1
        }
        col.addView(name)
        val c = card(col)
        action(c, "Create") {
            val n = name.text.toString().trim()
            // A folder exists once a tab is in it, so put the current tab there.
            if (n.isNotEmpty()) active?.folder = n
            showTabSheet()
        }
        action(c, "Cancel") { showTabSheet() }
    }

    private fun showFolderEditor(folder: String): Unit = openPanel("tabs") { col ->
        title(col, "Edit folder")
        val name = EditText(this).apply {
            setText(folder)
            setTextColor(0xFFE8E8EA.toInt())
            setBackgroundResource(R.drawable.pill_bg)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            maxLines = 1
        }
        col.addView(name)
        val c = card(col)
        action(c, "Rename") {
            val n = name.text.toString().trim()
            if (n.isNotEmpty()) tabs.filter { it.folder == folder }.forEach { it.folder = n }
            showTabSheet()
        }
        action(c, "Ungroup", "Tabs move out of the folder — none are closed") {
            tabs.filter { it.folder == folder }.forEach { it.folder = "" }
            showTabSheet()
        }
        action(c, "Cancel") { showTabSheet() }
    }

    private fun showTabEditor(index: Int): Unit = openPanel("tabs") { col ->
        val t = tabs.getOrNull(index) ?: return@openPanel
        title(col, "Edit tab")
        caption(col, t.url)
        val name = EditText(this).apply {
            setText(t.title)
            setTextColor(0xFFE8E8EA.toInt())
            setBackgroundResource(R.drawable.pill_bg)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            maxLines = 1
        }
        col.addView(name)
        val folders = tabs.map { it.folder }.filter { it.isNotEmpty() }.distinct().sorted()
        val c = card(col)
        action(c, "Save name") {
            t.label = name.text.toString().trim().ifEmpty { null }
            showTabSheet()
        }
        for (f in folders) {
            if (f != t.folder) action(c, "Move to \"$f\"") { t.folder = f; showTabSheet() }
        }
        if (t.folder.isNotEmpty()) action(c, "Remove from \"${t.folder}\"") { t.folder = ""; showTabSheet() }
        action(c, if (t.quick) "Unpin from top" else "Pin to top") { t.quick = !t.quick; showTabSheet() }
        action(c, "Cancel") { showTabSheet() }
    }

    // #52 v2: a real nested folder tree, matching the Windows sidebar —
    // tap the folder ROW to expand, subfolders nest and indent, everything
    // starts collapsed, and search flattens across the whole set.
    private class FolderNode {
        val subs = LinkedHashMap<String, FolderNode>()
        val items = ArrayList<Bookmark>()
    }

    private fun buildTree(list: List<Bookmark>): FolderNode {
        val root = FolderNode()
        pendingBmFolder?.let { p -> // #89: show a just-created empty folder
            var node = root
            for (seg in p.split('/').filter { it.isNotBlank() }) {
                node = node.subs.getOrPut(seg) { FolderNode() }
            }
        }
        for (b in list) {
            var node = root
            for (seg in b.folder.split('/').filter { it.isNotBlank() }) {
                node = node.subs.getOrPut(seg) { FolderNode() }
            }
            node.items.add(b)
        }
        return root
    }

    private fun countAll(node: FolderNode): Int =
        node.items.size + node.subs.values.sumOf { countAll(it) }

    private fun bookmarkRow(parent: LinearLayout, b: Bookmark, depth: Int) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8 + depth * 16), dp(4), dp(4), dp(4))
        }
        if (bmEditMode) {
            // #89: ☰ grabs the bookmark; folder headers accept the drop.
            row.addView(TextView(this).apply {
                text = "☰"
                setTextColor(0xFF7C7C82.toInt())
                textSize = 17f
                setPadding(0, dp(6), dp(12), dp(6))
                setOnLongClickListener {
                    val data = android.content.ClipData.newPlainText("bookmarkId", b.id)
                    startDragAndDrop(data, View.DragShadowBuilder(row), null, 0)
                    true
                }
            })
        }
        val line = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(5), 0, dp(5))
            isClickable = true
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            setOnClickListener { if (!bmEditMode) { closePanel(); navigate(b.url) } }
            setOnLongClickListener { // #91: keep place when entering edit mode
                pendingScrollY = currentScroll?.scrollY ?: 0
                bmEditMode = true
                showBookmarks()
                true
            }
        }
        line.addView(TextView(this).apply {
            text = b.title
            setTextColor(0xFFE8E8EA.toInt())
            textSize = 15f
            maxLines = 1
        })
        line.addView(TextView(this).apply {
            text = b.url
            setTextColor(0xFF7C7C82.toInt())
            textSize = 11f
            maxLines = 1
        })
        row.addView(line)
        if (bmEditMode) {
            row.addView(TextView(this).apply {
                text = "✎"
                setTextColor(0xFF7C7C82.toInt())
                textSize = 15f
                setPadding(dp(12), dp(6), dp(6), dp(6))
                setOnClickListener { showBookmarkEditor(b) }
            })
        }
        parent.addView(row)
    }

    /** Renders one folder level; children live in a container we show/hide,
     *  so expanding never rebuilds the panel or loses scroll position. */
    private fun emitFolders(parent: LinearLayout, node: FolderNode, depth: Int, path: String = "") {
        for ((name, sub) in node.subs.entries.sortedBy { it.key.lowercase() }) {
            val full = if (path.isEmpty()) name else "$path/$name" // #89
            val childBox = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                // #91: remembered across re-renders instead of always collapsing
                visibility = if (bmExpanded.contains(full)) View.VISIBLE else View.GONE
            }
            val headerRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val header = TextView(this).apply {
                text = "${if (bmExpanded.contains(full)) "▾" else "▸"}  📁  $name   ${countAll(sub)}"
                setTextColor(0xFFE8E8EA.toInt())
                textSize = 15f
                setTypeface(null, android.graphics.Typeface.BOLD)
                setPadding(dp(8 + depth * 16), dp(11), dp(8), dp(11))
                setOnClickListener {
                    val open = childBox.visibility == View.VISIBLE
                    childBox.visibility = if (open) View.GONE else View.VISIBLE
                    if (open) bmExpanded.remove(full) else bmExpanded.add(full) // #91
                    text = "${if (open) "▸" else "▾"}  📁  $name   ${countAll(sub)}"
                }
            }
            header.layoutParams =
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            // #89: dropping a dragged bookmark here re-files it.
            headerRow.setOnDragListener { _, ev ->
                if (ev.action == android.view.DragEvent.ACTION_DROP) {
                    val id = ev.clipData?.getItemAt(0)?.text?.toString()
                    val bm = id?.let { i -> BookmarkStore.all(this).find { it.id == i } }
                    if (bm != null) {
                        BookmarkStore.update(this, bm.id, bm.title, bm.url, full)
                        showBookmarks()
                    }
                }
                true
            }
            headerRow.addView(header)
            if (bmEditMode) {
                headerRow.addView(TextView(this).apply {
                    text = "✎"
                    setTextColor(0xFF7C7C82.toInt())
                    textSize = 15f
                    setPadding(dp(12), dp(8), dp(6), dp(8))
                    setOnClickListener { showBmFolderEditor(full) }
                })
            }
            parent.addView(headerRow)
            parent.addView(childBox)
            emitFolders(childBox, sub, depth + 1, full)
            for (b in sub.items.sortedBy { it.title.lowercase() }) bookmarkRow(childBox, b, depth + 1)
        }
    }

    private fun renderBookmarks(container: LinearLayout, query: String) {
        container.removeAllViews()
        val all = BookmarkStore.all(this)
        val q = query.trim().lowercase()
        if (q.isNotEmpty()) {
            // Search always finds everything, ignoring collapse state.
            val hits = all.filter {
                it.title.lowercase().contains(q) ||
                    it.url.lowercase().contains(q) ||
                    it.folder.lowercase().contains(q)
            }
            if (hits.isEmpty()) {
                container.addView(TextView(this).apply {
                    text = "No bookmarks match."
                    setTextColor(0xFF7C7C82.toInt())
                    setPadding(dp(8), dp(14), 0, 0)
                })
            }
            for (b in hits.take(300)) bookmarkRow(container, b, 0)
            return
        }
        val tree = buildTree(all)
        for (b in tree.items.sortedBy { it.title.lowercase() }) bookmarkRow(container, b, 0)
        emitFolders(container, tree, 0)
    }

    private fun showBookmarks(): Unit = openPanel("bookmarks") { col ->
        titleWithAction(col, "Bookmarks", "⚙") { showSettings() } // #87
        caption(
            col,
            if (bmEditMode) "Editing: hold ☰ to drag into a folder, ✎ to edit. Swipe right to leave."
            else "Tap to open · long-press to organize · swipe right to go back."
        )
        val bmActions = card(col)
        if (bmEditMode) {
            action(bmActions, "＋ New folder") { showBmFolderCreator() }
            action(bmActions, "Done editing") { bmEditMode = false; showBookmarks() }
        } else {
            action(bmActions, "Organize bookmarks", "Drag into folders, rename, re-file") {
                bmEditMode = true
                showBookmarks()
            }
        }

        val all = BookmarkStore.all(this)
        if (all.isEmpty()) {
            // #89: no manual button — syncing is automatic; just say where we are.
            row(col, "Nothing cached yet", BookmarkStore.statusLine(this)) { }
            BookmarkStore.sync(this) { ok -> runOnUiThread { if (ok) showBookmarks() } }
            return@openPanel
        }

        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(EditText(this).apply {
            hint = "Search bookmarks"
            setHintTextColor(0xFF7C7C82.toInt())
            setTextColor(0xFFE8E8EA.toInt())
            textSize = 14f
            setBackgroundResource(R.drawable.urlbar_bg)
            setPadding(dp(14), dp(8), dp(14), dp(8))
            maxLines = 1
            addTextChangedListener(object : android.text.TextWatcher {
                override fun afterTextChanged(sx: android.text.Editable?) {
                    renderBookmarks(list, sx?.toString() ?: "")
                }
                override fun beforeTextChanged(cs: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun onTextChanged(cs: CharSequence?, a: Int, b: Int, c: Int) {}
            })
        })
        col.addView(list)
        renderBookmarks(list, "")

        col.addView(TextView(this).apply {
            text = BookmarkStore.statusLine(this@MainActivity) // #89: passive status, no button
            setTextColor(0xFF7C7C82.toInt())
            textSize = 11.5f
            setPadding(dp(4), dp(18), dp(4), 0)
        })
    }

    // #85: long-press editor — the phone could only open bookmarks before.
    /** #89: rename or dissolve a bookmark folder. */
    private fun showBmFolderEditor(folder: String): Unit = openPanel("bookmarks") { col ->
        title(col, "Edit folder")
        caption(col, folder)
        val name = EditText(this).apply {
            setText(folder)
            setTextColor(0xFFE8E8EA.toInt())
            setBackgroundResource(R.drawable.pill_bg)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            maxLines = 1
        }
        col.addView(name)
        val c = card(col)
        action(c, "Rename", "Everything inside moves with it") {
            val to = name.text.toString().trim()
            if (to.isNotEmpty() && to != folder) {
                for (b in BookmarkStore.all(this).filter { it.folder == folder || it.folder.startsWith("$folder/") }) {
                    BookmarkStore.update(this, b.id, b.title, b.url, to + b.folder.substring(folder.length))
                }
            }
            showBookmarks()
        }
        action(c, "Dissolve folder", "Bookmarks move up a level — none are deleted") {
            val parent = if (folder.contains('/')) folder.substringBeforeLast('/') else ""
            for (b in BookmarkStore.all(this).filter { it.folder == folder || it.folder.startsWith("$folder/") }) {
                BookmarkStore.update(this, b.id, b.title, b.url, parent)
            }
            showBookmarks()
        }
        action(c, "Cancel") { showBookmarks() }
    }

    private fun showBmFolderCreator(): Unit = openPanel("bookmarks") { col ->
        title(col, "New bookmark folder")
        caption(col, "Use Work/CI to nest. Drag bookmarks onto it afterwards.")
        val name = EditText(this).apply {
            hint = "Folder name"
            setHintTextColor(0xFF7C7C82.toInt())
            setTextColor(0xFFE8E8EA.toInt())
            setBackgroundResource(R.drawable.pill_bg)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            maxLines = 1
        }
        col.addView(name)
        val c = card(col)
        action(c, "Create", "Takes effect once a bookmark is filed into it") {
            pendingBmFolder = name.text.toString().trim().trim('/')
            showBookmarks()
        }
        action(c, "Cancel") { showBookmarks() }
    }

    private fun showBookmarkEditor(b: Bookmark): Unit = openPanel("bookmarks") { col ->
        title(col, "Edit bookmark")
        caption(col, "Changes sync back to your other devices when you're on the home network.")

        fun field(label: String, value: String): EditText {
            col.addView(TextView(this).apply {
                text = label.uppercase()
                setTextColor(0xFF7C7C82.toInt())
                textSize = 11f
                setPadding(dp(4), dp(10), 0, dp(4))
            })
            val e = EditText(this).apply {
                setText(value)
                setTextColor(0xFFE8E8EA.toInt())
                textSize = 14f
                setBackgroundResource(R.drawable.pill_bg)
                setPadding(dp(14), dp(10), dp(14), dp(10))
                maxLines = 1
            }
            col.addView(e)
            return e
        }

        val title = field("Title", b.title)
        val url = field("URL", b.url)
        val folder = field("Folder (use / to nest)", b.folder)

        val actions = card(col)
        action(actions, "Save changes") {
            BookmarkStore.update(this, b.id, title.text.toString().trim(),
                url.text.toString().trim(), folder.text.toString().trim())
            showBookmarks() // #99: no closePanel — that would drop edit mode
        }
        action(actions, "Open this bookmark") { closePanel(); navigate(b.url) }
        action(actions, "Delete bookmark", "Removes it here and on your other devices") {
            BookmarkStore.remove(this, b.id)
            showBookmarks() // #99
        }
        action(actions, "Cancel") { showBookmarks() } // #99
    }

    private fun showPersonaCreator(): Unit = openPanel { col ->
        title(col, "New persona")
        val name = EditText(this).apply {
            hint = "Name (e.g. Finance)"
            setHintTextColor(0xFF7C7C82.toInt())
            setTextColor(0xFFE8E8EA.toInt())
            setBackgroundResource(R.drawable.pill_bg)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            maxLines = 1
        }
        col.addView(name)
        val c = card(col)
        action(c, "Create") { Personas.add(this, name.text.toString()); showSettings() }
        action(c, "Cancel") { showSettings() }
    }

    private fun showPersonaEditor(id: String): Unit = openPanel { col ->
        val p = Personas.get(this, id) ?: return@openPanel
        title(col, "Edit persona")
        val name = EditText(this).apply {
            setText(p.name)
            setTextColor(0xFFE8E8EA.toInt())
            setBackgroundResource(R.drawable.pill_bg)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            maxLines = 1
        }
        col.addView(name)
        col.addView(TextView(this).apply {
            text = "RULES (ONE PER LINE)"
            setTextColor(0xFF7C7C82.toInt())
            textSize = 11f
            setPadding(dp(4), dp(14), 0, dp(4))
        })
        val rules = EditText(this).apply {
            setText(p.rules.joinToString("\n"))
            setTextColor(0xFFE8E8EA.toInt())
            textSize = 13f
            setBackgroundResource(R.drawable.pill_bg)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            minLines = 3
            setSingleLine(false)
        }
        col.addView(rules)
        val c = card(col)
        action(c, "Save") {
            Personas.update(this, id, name.text.toString(), rules.text.toString().split("\n"))
            showSettings()
        }
        action(c, "Delete persona", "Its tabs move to Unassigned — none are closed") {
            tabs.filter { it.persona == id }.forEach { it.persona = Personas.UNASSIGNED }
            Personas.remove(this, id)
            showSettings()
        }
        action(c, "Cancel") { showSettings() }
    }

    private fun showSettings(): Unit = openPanel { col ->
        title(col, "Settings")
        caption(col, "Swipe right to go back.")

        header(col, "SECURITY")
        caption(
            col,
            // #55: deliberately different from Windows, where the vault gates the
            // whole app. Here it gates saved passwords only — browsing never waits.
            "A master password protects saved logins. Browsing works whether it's locked or not."
        )
        val sec = card(col)
        when {
            !Vault.isInitialized(this) ->
                action(sec, "Set a master password", "Needed before logins can be saved") {
                    showVaultSetup()
                }
            !Vault.isUnlocked() ->
                action(sec, "🔒 Unlock saved logins", Vault.statusLine(this)) { showVaultUnlock() }
            else -> {
                action(sec, "🔓 Unlocked", "Lock again to require the password") {
                    Vault.lock()
                    showSettings()
                }
                if (Vault.biometricAvailable() && !Vault.isBiometricEnrolled(this)) {
                    action(sec, "Enable biometric unlock", "Use your fingerprint instead of typing it") {
                        enrolBiometric()
                    }
                } else if (Vault.isBiometricEnrolled(this)) {
                    action(sec, "Biometric unlock is on", "Tap to turn it off") {
                        Vault.clearBiometric(this)
                        showSettings()
                    }
                }
            }
        }
        if (Vault.isInitialized(this)) {
            action(sec, "Reset the vault", "Forgotten password? This deletes saved logins — no recovery") {
                showVaultReset()
            }
        }

        header(col, "THIS PAGE")
        val page = card(col)
        // #101: the phone's stand-in for Ctrl+F. Closing the panel first means
        // the bar and the page are both visible the moment it opens.
        action(page, "🔍 Find in page", "Search the text of the page you're on") {
            closePanel()
            openFind()
        }

        header(col, "SEARCH")
        val engines = card(col)
        val current = Prefs.engineKey(this)
        for ((key, pair) in Prefs.ENGINES) {
            option(engines, pair.first, key == current) {
                Prefs.setEngine(this, key)
                showSettings()
            }
        }

        header(col, "CLOSE IDLE TABS")
        caption(col, "Normal tabs close after this long unused. Pinned and quick-launch tabs never expire, and the tab you're on never closes.")
        val expiry = card(col)
        val curExpiry = Prefs.expiryKey(this)
        for ((key, hrs) in Prefs.EXPIRY) {
            option(expiry, if (hrs == 0) "Never" else key, key == curExpiry) {
                Prefs.setExpiry(this, key)
                sweepStaleTabs()
                showSettings()
            }
        }

        header(col, "PERSONAS")
        caption(col, "Workspaces with their own tabs. Opening a URL that matches a Persona's rules switches to it; anything unmatched lands in Unassigned. One rule per line — prefix, wildcard (https://*.example.com) or /regex/.")
        val pc = card(col)
        for (p in Personas.ordered(this)) {
            action(pc, p.name, if (p.builtin) "Built-in · catches everything unmatched" else "${p.rules.size} rule(s) · tap to edit") {
                if (!p.builtin) showPersonaEditor(p.id)
            }
        }
        action(pc, "＋ New persona") { showPersonaCreator() }

        header(col, "BOOKMARKS")
        val sync = card(col)
        action(sync, "${BookmarkStore.all(this).size} bookmarks", BookmarkStore.statusLine(this)) { }

        header(col, "ABOUT")
        val about = card(col)
        action(about, "Version ${BuildConfig.VERSION_NAME}", "Tap to check for updates") {
            UpdateManager(this).checkForUpdate()
        }
        action(about, "How WebForge is built", "Engines, dependencies, build process") { showAbout() }
        CrashLog.last(this)?.let { trace ->
            header(col, "LAST CRASH")
            val crash = card(col)
            crash.addView(TextView(this).apply {
                text = trace.take(1800)
                setTextColor(0xFFC04040.toInt())
                textSize = 10f
                setPadding(dp(14), dp(12), dp(14), dp(12))
                setTextIsSelectable(true)
            })
            action(crash, "Clear crash report") { CrashLog.clear(this); showSettings() }
        }
    }

    // --- #55: master-password vault ----------------------------------------

    /** A password field styled like the rest of the panel inputs. */
    private fun passwordField(col: LinearLayout, hint: String): EditText {
        val e = EditText(this).apply {
            this.hint = hint
            setHintTextColor(0xFF7C7C82.toInt())
            setTextColor(0xFFE8E8EA.toInt())
            textSize = 14f
            setBackgroundResource(R.drawable.pill_bg)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            maxLines = 1
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        col.addView(e)
        return e
    }

    private fun note(col: LinearLayout, text: String, warn: Boolean = false) {
        col.addView(TextView(this).apply {
            this.text = text
            setTextColor(if (warn) 0xFFC04040.toInt() else 0xFF7C7C82.toInt())
            textSize = 12f
            setPadding(dp(4), dp(10), dp(4), 0)
        })
    }

    private fun showVaultSetup(): Unit = openPanel { col ->
        title(col, "Set master password")
        caption(
            col,
            // #105 will derive the credential sync key from this password, so the
            // two devices must agree. Saying so here is cheaper than debugging it.
            "Protects saved logins on this phone. Use the SAME password as the " +
                "Windows app — syncing logins between devices depends on them matching. " +
                "There is no recovery if you forget it."
        )
        val first = passwordField(col, "Master password")
        val again = passwordField(col, "Repeat it")
        val msg = TextView(this).apply {
            setTextColor(0xFFC04040.toInt())
            textSize = 12f
            setPadding(dp(4), dp(10), dp(4), 0)
        }
        col.addView(msg)
        val c = card(col)
        action(c, "Set password") {
            val a = first.text.toString()
            val b = again.text.toString()
            when {
                a.isEmpty() -> msg.text = "Enter a password."
                a != b -> msg.text = "The two entries don't match."
                !Vault.setup(this, a) -> msg.text = "Couldn't create the vault."
                else -> showSettings()
            }
        }
        action(c, "Cancel") { showSettings() }
    }

    private fun showVaultUnlock(): Unit = openPanel { col ->
        title(col, "Unlock saved logins")
        caption(col, Vault.statusLine(this))
        val pw = passwordField(col, "Master password")
        val msg = TextView(this).apply {
            setTextColor(0xFFC04040.toInt())
            textSize = 12f
            setPadding(dp(4), dp(10), dp(4), 0)
        }
        col.addView(msg)
        val c = card(col)
        action(c, "Unlock") {
            if (Vault.unlock(this, pw.text.toString())) showSettings()
            else msg.text = "Wrong password."
        }
        if (Vault.isBiometricEnrolled(this)) {
            action(c, "Use fingerprint instead") { biometricUnlock() }
        }
        action(c, "Cancel") { showSettings() }
    }

    private fun showVaultReset(): Unit = openPanel { col ->
        title(col, "Reset the vault")
        caption(
            col,
            "Deletes the master password and every saved login on this phone. " +
                "Nothing is recoverable. Logins saved on other devices are untouched."
        )
        val c = card(col)
        action(c, "Delete everything and start over") {
            Vault.reset(this)
            showSettings()
        }
        action(c, "Cancel") { showSettings() }
    }

    // Framework BiometricPrompt (API 28+) rather than androidx.biometric — this
    // app has no AndroidX dependencies and one prompt is not worth starting.
    // Below API 28 the password is simply the only way in.
    @android.annotation.TargetApi(Build.VERSION_CODES.P)
    private fun biometricPrompt(titleText: String, cipher: javax.crypto.Cipher, onOk: (javax.crypto.Cipher) -> Unit) {
        val prompt = android.hardware.biometrics.BiometricPrompt.Builder(this)
            .setTitle(titleText)
            .setDescription("Unlocks your saved logins")
            .setNegativeButton("Use password", mainExecutor) { _, _ -> }
            .build()
        prompt.authenticate(
            android.hardware.biometrics.BiometricPrompt.CryptoObject(cipher),
            android.os.CancellationSignal(),
            mainExecutor,
            object : android.hardware.biometrics.BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(
                    result: android.hardware.biometrics.BiometricPrompt.AuthenticationResult
                ) {
                    val c = result.cryptoObject?.cipher ?: return
                    onOk(c)
                }
            }
        )
    }

    private fun enrolBiometric() {
        if (!Vault.biometricAvailable()) return
        val cipher = Vault.beginBiometricEnrol() ?: return
        biometricPrompt("Enable biometric unlock", cipher) { c ->
            Vault.finishBiometricEnrol(this, c)
            runOnUiThread { showSettings() }
        }
    }

    private fun biometricUnlock() {
        if (!Vault.biometricAvailable()) return
        // Null here means the Keystore key is gone (a fingerprint re-enrolment
        // invalidates it). Vault has already dropped the wrap; password remains.
        val cipher = Vault.beginBiometricUnlock(this) ?: run { showVaultUnlock(); return }
        biometricPrompt("Unlock saved logins", cipher) { c ->
            Vault.finishBiometricUnlock(this, c)
            runOnUiThread { showSettings() }
        }
    }

    private fun showAbout(): Unit = openPanel { col ->
        title(col, "About WebForge")
        caption(col, "Swipe right to go back.")

        // Live facts read from the device, never hardcoded.
        header(col, "THIS BUILD, RIGHT NOW")
        val wv = try {
            android.webkit.WebView.getCurrentWebViewPackage()
        } catch (e: Exception) {
            null
        }
        val live = linkedMapOf(
            "WebForge" to BuildConfig.VERSION_NAME,
            "Engine (System WebView)" to (wv?.let { "${it.packageName} ${it.versionName}" } ?: "unknown"),
            "Android" to "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            "Device" to "${Build.MANUFACTURER} ${Build.MODEL}",
            "Release channel" to "self-hosted (dockerhost :8012)",
        )
        for ((k, v) in live) {
            col.addView(TextView(this).apply {
                text = "$k\n$v"
                setTextColor(0xFFE8E8EA.toInt())
                textSize = 13f
                setPadding(0, dp(6), 0, dp(6))
            })
        }

        // Shared documentation, identical to the Windows About page.
        val sections = try {
            val raw = assets.open("about.json").bufferedReader().use { it.readText() }
            org.json.JSONObject(raw).optJSONArray("sections")
        } catch (e: Exception) {
            null
        }
        if (sections == null) {
            row(col, "Documentation unavailable", "shared/about.json missing from assets") { }
        } else {
            for (i in 0 until sections.length()) {
                val sec = sections.optJSONObject(i) ?: continue
                val platform = sec.optString("platform")
                val tag = when (platform) {
                    "windows" -> "WINDOWS"
                    "android" -> "ANDROID"
                    else -> "BOTH PLATFORMS"
                }
                header(col, "${sec.optString("title").uppercase()}  ·  $tag")
                val items = sec.optJSONArray("items") ?: continue
                for (j in 0 until items.length()) {
                    val it = items.optJSONObject(j) ?: continue
                    col.addView(TextView(this).apply {
                        text = it.optString("label")
                        setTextColor(0xFFE8E8EA.toInt())
                        textSize = 14f
                        setTypeface(null, android.graphics.Typeface.BOLD)
                        setPadding(0, dp(10), 0, 0)
                    })
                    col.addView(TextView(this).apply {
                        text = it.optString("value")
                        setTextColor(0xFFE8E8EA.toInt())
                        textSize = 13f
                    })
                    val note = it.optString("note")
                    if (note.isNotEmpty()) {
                        col.addView(TextView(this).apply {
                            text = note
                            setTextColor(0xFF7C7C82.toInt())
                            textSize = 12f
                            setPadding(0, dp(3), 0, 0)
                        })
                    }
                }
            }
        }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            findOpen -> closeFind() // #101: the find bar is the topmost thing
            overlay.visibility == View.VISIBLE -> closePanel()
            active?.webView?.canGoBack() == true -> active?.webView?.goBack()
            tabs.size > 1 -> closeTab(activeIndex)
            else -> super.onBackPressed()
        }
    }

    override fun onResume() {
        super.onResume()
        UpdateManager(this).checkForUpdate()
        sweepStaleTabs() // #79: catch up after the app has been away
        // #84: the app only pulled at launch, so bookmarks edited on the PC
        // never appeared until a cold start. Refresh every time we come back.
        BookmarkStore.sync(this) { }
        Personas.sync(this) { runOnUiThread { rehomeTabs() } } // #88/#96
        syncTabsAcrossDevices() // #57
        sweepHandler.removeCallbacksAndMessages(null)
        sweepHandler.postDelayed(object : Runnable {
            override fun run() {
                sweepStaleTabs()
                syncTabsAcrossDevices() // #95: keep tabs live, not just on resume
                sweepHandler.postDelayed(this, 30_000L)
            }
        }, 30_000L)
    }

    override fun onPause() {
        super.onPause()
        sweepHandler.removeCallbacksAndMessages(null)
    }
}
