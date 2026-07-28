package com.webforge.browser

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
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
    private var nextTabId = 1

    private val active: Tab? get() = tabs.getOrNull(activeIndex)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webContainer = findViewById(R.id.webContainer)
        overlay = findViewById(R.id.overlay)
        urlBar = findViewById(R.id.urlBar)
        tabsBtn = findViewById(R.id.tabsBtn)
        progress = findViewById(R.id.progress)

        goFullscreen()

        urlBar.setOnEditorActionListener { _, actionId, event ->
            val enter = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
            if (actionId == EditorInfo.IME_ACTION_GO || enter) {
                Prefs.resolveInput(this, urlBar.text.toString())?.let { navigate(it) }
                true
            } else false
        }
        tabsBtn.setOnClickListener { showTabSheet() }
        findViewById<TextView>(R.id.menuBtn).setOnClickListener { showMenu() }

        newTab(START_URL)
        BookmarkStore.sync(this) { } // warm the cache for the bookmarks panel
        UpdateManager(this).checkForUpdate()
    }

    // --- #51: truly fullscreen — no status bar, no navigation bar ----------
    private fun goFullscreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.apply {
                hide(WindowInsets.Type.systemBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        }
        // Draw into the display cutout too — every pixel is ours.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goFullscreen() // the bars creep back after IME/task switch
    }

    // --- tabs ---------------------------------------------------------------
    @SuppressLint("SetJavaScriptEnabled")
    private fun newTab(url: String, background: Boolean = false): Tab {
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

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                if (tab === active) syncChrome()
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (tab === active) syncChrome()
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
        }

        tabs.add(tab)
        wv.loadUrl(url)
        if (!background) activateTab(tabs.size - 1) else syncChrome()
        return tab
    }

    private fun activateTab(index: Int) {
        if (index !in tabs.indices) return
        activeIndex = index
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
        tabs.removeAt(index)
        (tab.webView.parent as? ViewGroup)?.removeView(tab.webView)
        tab.webView.destroy()
        if (tabs.isEmpty()) {
            newTab(START_URL)
        } else {
            activateTab(index.coerceAtMost(tabs.size - 1))
        }
    }

    private fun navigate(url: String) {
        urlBar.clearFocus()
        hideKeyboard()
        (active ?: newTab(url).also { return }).webView.loadUrl(url)
    }

    private fun syncChrome() {
        val t = active ?: return
        if (!urlBar.hasFocus()) urlBar.setText(if (t.url == "about:blank") "" else t.url)
        tabsBtn.text = tabs.size.toString()
    }

    private fun hideKeyboard() {
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager)
            .hideSoftInputFromWindow(urlBar.windowToken, 0)
    }

    // --- overlay panels ------------------------------------------------------
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
    }

    private fun closePanel() {
        overlay.visibility = View.GONE
        overlay.removeAllViews()
        goFullscreen()
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
        col.addView(TextView(this).apply {
            text = "Tabs"
            setTextColor(0xFFE8E8EA.toInt())
            textSize = 22f
        })
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
        col.addView(TextView(this).apply {
            text = "WebForge"
            setTextColor(0xFFE8E8EA.toInt())
            textSize = 22f
        })
        row(col, "Bookmarks", "Browse your synced bookmarks") { showBookmarks() }
        row(col, "Settings", "Search engine, sync, updates") { showSettings() }
        row(col, "New tab") { closePanel(); newTab(START_URL) }
        active?.let { t ->
            row(col, if (t.quick) "Unset quick launch" else "Set as quick launch",
                "Sticky tab that only ever shows this site") {
                t.quick = !t.quick
                closePanel()
            }
        }
        row(col, "Reload") { closePanel(); active?.webView?.reload() }
        row(col, "Close") { closePanel() }
    }

    private fun showBookmarks(): Unit = openPanel { col ->
        col.addView(TextView(this).apply {
            text = "Bookmarks"
            setTextColor(0xFFE8E8EA.toInt())
            textSize = 22f
        })
        val all = BookmarkStore.all(this)
        if (all.isEmpty()) {
            row(col, "Nothing cached yet", "Connect to your home network to sync") { }
            row(col, "Sync now") {
                BookmarkStore.sync(this) { ok -> runOnUiThread { if (ok) showBookmarks() } }
            }
            row(col, "Close") { closePanel() }
            return@openPanel
        }
        // Root-level bookmarks first, then one collapsed section per folder.
        val byFolder = all.groupBy { it.folder }
        byFolder[""]?.forEach { b -> row(col, b.title, b.url) { closePanel(); navigate(b.url) } }
        for (folder in byFolder.keys.filter { it.isNotEmpty() }.sorted()) {
            val items = byFolder[folder] ?: continue
            header(col, "$folder  (${items.size})")
            val box = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                visibility = View.GONE
            }
            items.forEach { b -> row(box, b.title, b.url) { closePanel(); navigate(b.url) } }
            col.addView(TextView(this).apply {
                text = "▸ open folder"
                setTextColor(0xFF3D9BFF.toInt())
                textSize = 13f
                setPadding(0, 0, 0, dp(6))
                setOnClickListener {
                    box.visibility = if (box.visibility == View.GONE) View.VISIBLE else View.GONE
                    text = if (box.visibility == View.VISIBLE) "▾ close folder" else "▸ open folder"
                }
            })
            col.addView(box)
        }
        row(col, "Sync now") {
            BookmarkStore.sync(this) { ok -> runOnUiThread { if (ok) showBookmarks() } }
        }
        row(col, "Close") { closePanel() }
    }

    private fun showSettings(): Unit = openPanel { col ->
        col.addView(TextView(this).apply {
            text = "Settings"
            setTextColor(0xFFE8E8EA.toInt())
            textSize = 22f
        })
        header(col, "DEFAULT SEARCH ENGINE")
        val current = Prefs.engineKey(this)
        for ((key, pair) in Prefs.ENGINES) {
            row(col, (if (key == current) "●  " else "○  ") + pair.first) {
                Prefs.setEngine(this, key)
                showSettings()
            }
        }
        header(col, "SYNC")
        row(col, "Bookmarks cached: ${BookmarkStore.all(this).size}", "Tap to sync now") {
            BookmarkStore.sync(this) { ok ->
                runOnUiThread {
                    if (ok) showSettings()
                    else android.widget.Toast
                        .makeText(this, "Server unreachable — using local cache", android.widget.Toast.LENGTH_SHORT)
                        .show()
                }
            }
        }
        header(col, "ABOUT")
        row(col, "Version ${BuildConfig.VERSION_NAME}", "Tap to check for updates") {
            UpdateManager(this).checkForUpdate()
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
    }
}
