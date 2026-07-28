package com.webforge.browser

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText

class MainActivity : Activity() {

    companion object {
        private const val HOME_URL = "https://duckduckgo.com/"
        private const val SEARCH_URL = "https://duckduckgo.com/?q="
    }

    private lateinit var webView: WebView
    private lateinit var urlBar: EditText

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        urlBar = findViewById(R.id.urlBar)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // Desktop-grade rendering defaults for a phone browser shell.
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
        }

        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            // Keep ALL navigation inside our WebView instead of punting to the
            // system's default browser — we ARE the browser.
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean = false

            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                if (!urlBar.hasFocus()) urlBar.setText(url)
                super.doUpdateVisitedHistory(view, url, isReload)
            }
        }

        urlBar.setOnEditorActionListener { _, actionId, event ->
            val enterPressed = event?.keyCode == KeyEvent.KEYCODE_ENTER &&
                event.action == KeyEvent.ACTION_DOWN
            if (actionId == EditorInfo.IME_ACTION_GO || enterPressed) {
                navigateTo(urlBar.text.toString())
                true
            } else false
        }

        if (savedInstanceState == null) {
            webView.loadUrl(HOME_URL)
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    override fun onResume() {
        super.onResume()
        // #5: check on EVERY foreground, not just cold launch — a resumed app
        // must notice releases staged while it sat in recents. UpdateManager
        // guards against parallel checks and re-prompting a declined version.
        UpdateManager(this).checkForUpdate()
    }

    private fun navigateTo(input: String) {
        val text = input.trim()
        if (text.isEmpty()) return
        val url = when {
            text.startsWith("http://") || text.startsWith("https://") -> text
            // Looks like a host (has a dot, no spaces) → treat as an address;
            // anything else becomes a search query.
            !text.contains(' ') && text.contains('.') -> "https://$text"
            else -> SEARCH_URL + android.net.Uri.encode(text)
        }
        urlBar.clearFocus()
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager)
            .hideSoftInputFromWindow(urlBar.windowToken, 0)
        webView.loadUrl(url)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
