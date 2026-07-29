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
    val title: String get() = webView.title?.takeIf { it.isNotBlank() } ?: url
    val url: String get() = webView.url ?: "about:blank"
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
    private var nextTabId = 1

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
        findViewById<TextView>(R.id.menuBtn).setOnClickListener { showMenu() }

        newTab(START_URL)
        BookmarkStore.sync(this) { } // warm the cache for the bookmarks panel
        UpdateManager(this).checkForUpdate()
    }

    // --- #58: status bar VISIBLE above our bar; navigation bar hidden ------
    private fun goFullscreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false) // we position around insets
            window.insetsController?.apply {
                hide(WindowInsets.Type.navigationBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                // Clear the light-status-bar flag so icons stay white on black.
                setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS)
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
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
            // Panels must clear the status bar too.
            overlay.setPadding(0, padded, 0, 0)
            insets
        }
        root.requestApplyInsets()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goFullscreen() // the bars creep back after IME/task switch
    }

    // --- tabs ---------------------------------------------------------------
    @SuppressLint("SetJavaScriptEnabled")
    private fun newTab(url: String?, background: Boolean = false): Tab {
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
        val tab = Tab(nextTabId++, wv)

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
        activeIndex = index
        tabs[index].lastActiveAt = System.currentTimeMillis() // #79
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

    private fun closeTab(index: Int) {
        val tab = tabs.getOrNull(index) ?: return
        if (tab.pinned) return
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
        tabsBtn.text = tabs.size.toString()
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

    private fun openPanel(build: (LinearLayout) -> Unit) {
        val scroll = ScrollView(this)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(36), dp(20), dp(28))
        }
        build(col)
        scroll.addView(col)
        overlay.removeAllViews()
        overlay.addView(scroll)
        overlay.visibility = View.VISIBLE
        @Suppress("ClickableViewAccessibility")
        overlay.setOnTouchListener { _, ev -> panelSwipe.onTouchEvent(ev); false } // #84
    }

    private fun closePanel() {
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

    private fun showTabSheet(): Unit = openPanel { col ->
        title(col, "Tabs")
        caption(col, "Swipe right to go back.")
        row(col, "＋  New tab") { closePanel(); newTab(START_URL) }

        // Quick-launch tabs stick to the top, then pinned, then the rest (#51).
        val order = tabs.indices.sortedWith(
            compareBy({ if (tabs[it].quick) 0 else if (tabs[it].pinned) 1 else 2 }, { it })
        )
        var lastGroup = -1
        for (i in order) {
            val t = tabs[i]
            val group = if (t.quick) 0 else if (t.pinned) 1 else 2
            if (group != lastGroup) {
                header(col, when (group) { 0 -> "QUICK LAUNCH"; 1 -> "PINNED"; else -> "OPEN TABS" })
                lastGroup = group
            }
            val line = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(10), 0, dp(10))
            }
            line.addView(TextView(this).apply {
                text = (if (i == activeIndex) "▸ " else "") + t.title
                setTextColor(if (i == activeIndex) 0xFF3D9BFF.toInt() else 0xFFE8E8EA.toInt())
                textSize = 15f
                maxLines = 1
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                setOnClickListener { closePanel(); activateTab(i) }
            })
            if (!t.pinned) {
                line.addView(TextView(this).apply {
                    text = "✕"
                    setTextColor(0xFF7C7C82.toInt())
                    textSize = 16f
                    setPadding(dp(14), 0, dp(4), 0)
                    setOnClickListener { closePanel(); closeTab(i) }
                })
            }
            col.addView(line)
        }
        row(col, "Close") { closePanel() }
    }

    private fun showMenu(): Unit = openPanel { col ->
        title(col, "WebForge")
        caption(col, "Swipe right to go back.")
        row(col, "Bookmarks", "Browse your synced bookmarks") { showBookmarks() }
        row(col, "Settings", "Search engine, sync, updates") { showSettings() }
        row(col, "About", "Architecture, engines, dependencies, build") { showAbout() }
        row(col, "New tab") { closePanel(); newTab(START_URL) }
        active?.let { t ->
            row(
                col,
                if (t.quick) "Stop pinning this site to the top" else "Pin this site to the top of my tabs",
                if (t.quick) {
                    "Currently pinned: this tab stays at the top and links open in new tabs."
                } else {
                    "Keeps this tab at the top of the tab list and never lets it wander — " +
                        "links you tap open in a new tab instead. Good for a site you always want one click away."
                }
            ) {
                t.quick = !t.quick
                closePanel()
            }
        }
        row(col, "Reload") { closePanel(); active?.webView?.reload() }
        row(col, "Close") { closePanel() }
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
        val line = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8 + depth * 16), dp(9), dp(8), dp(9))
            isClickable = true
            setOnClickListener { closePanel(); navigate(b.url) }
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
        parent.addView(line)
    }

    /** Renders one folder level; children live in a container we show/hide,
     *  so expanding never rebuilds the panel or loses scroll position. */
    private fun emitFolders(parent: LinearLayout, node: FolderNode, depth: Int) {
        for ((name, sub) in node.subs.entries.sortedBy { it.key.lowercase() }) {
            val childBox = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                visibility = View.GONE // collapsed by default, like Windows
            }
            val header = TextView(this).apply {
                text = "▸  📁  $name   ${countAll(sub)}"
                setTextColor(0xFFE8E8EA.toInt())
                textSize = 15f
                setTypeface(null, android.graphics.Typeface.BOLD)
                setPadding(dp(8 + depth * 16), dp(11), dp(8), dp(11))
                setOnClickListener {
                    val open = childBox.visibility == View.VISIBLE
                    childBox.visibility = if (open) View.GONE else View.VISIBLE
                    text = "${if (open) "▸" else "▾"}  📁  $name   ${countAll(sub)}"
                }
            }
            parent.addView(header)
            parent.addView(childBox)
            emitFolders(childBox, sub, depth + 1)
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

    private fun showBookmarks(): Unit = openPanel { col ->
        title(col, "Bookmarks")

        val all = BookmarkStore.all(this)
        if (all.isEmpty()) {
            row(col, "Nothing cached yet", "Connect to your home network to sync") { }
            row(col, "Sync now") {
                BookmarkStore.sync(this) { ok -> runOnUiThread { if (ok) showBookmarks() } }
            }
            row(col, "Close") { closePanel() }
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

        row(col, "Sync now", "${all.size} cached") {
            BookmarkStore.sync(this) { ok -> runOnUiThread { if (ok) showBookmarks() } }
        }
        row(col, "Close") { closePanel() }
    }

    private fun showSettings(): Unit = openPanel { col ->
        title(col, "Settings")
        caption(col, "Swipe right to go back.")

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

        header(col, "BOOKMARKS")
        val sync = card(col)
        action(sync, "${BookmarkStore.all(this).size} bookmarks cached", "Synced from your home server — tap to refresh now") {
            BookmarkStore.sync(this) { ok ->
                runOnUiThread {
                    if (ok) showSettings()
                    else android.widget.Toast
                        .makeText(this, "Server unreachable — using the local copy", android.widget.Toast.LENGTH_SHORT)
                        .show()
                }
            }
        }

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
        row(col, "Close") { closePanel() }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
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
        sweepHandler.removeCallbacksAndMessages(null)
        sweepHandler.postDelayed(object : Runnable {
            override fun run() {
                sweepStaleTabs()
                sweepHandler.postDelayed(this, 5 * 60_000L)
            }
        }, 5 * 60_000L)
    }

    override fun onPause() {
        super.onPause()
        sweepHandler.removeCallbacksAndMessages(null)
    }
}
