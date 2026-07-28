package com.webforge.browser

import android.content.Context

/**
 * Local settings (#53). Mirrors the Windows settings.json keys so the two
 * platforms can converge on one synced settings blob later.
 */
object Prefs {
    private const val FILE = "webforge"
    const val ENGINE_DEFAULT = "google"

    val ENGINES = linkedMapOf(
        "google" to Pair("Google", "https://www.google.com/search?q="),
        "duckduckgo" to Pair("DuckDuckGo", "https://duckduckgo.com/?q="),
        "bing" to Pair("Bing", "https://www.bing.com/search?q="),
        "brave" to Pair("Brave", "https://search.brave.com/search?q="),
    )

    private fun sp(c: Context) = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun engineKey(c: Context): String {
        val k = sp(c).getString("searchEngine", ENGINE_DEFAULT) ?: ENGINE_DEFAULT
        return if (ENGINES.containsKey(k)) k else ENGINE_DEFAULT
    }

    fun setEngine(c: Context, key: String) {
        if (ENGINES.containsKey(key)) sp(c).edit().putString("searchEngine", key).apply()
    }

    fun searchUrl(c: Context) = ENGINES[engineKey(c)]!!.second

    // A bare IP (optionally with a port) is a LAN/tailnet box, which is
    // almost always plain HTTP — defaulting those to https:// just fails (#59).
    private val RAW_HOST = Regex("""^\d{1,3}(\.\d{1,3}){3}(:\d+)?(/.*)?$""")

    /** Same resolution rules as the Windows address bar. */
    fun resolveInput(c: Context, raw: String): String? {
        val t = raw.trim()
        if (t.isEmpty()) return null
        if (t.startsWith("http://") || t.startsWith("https://")) return t
        if (RAW_HOST.matches(t)) return "http://$t"
        if (!t.contains(' ') && t.contains('.')) return "https://$t"
        return searchUrl(c) + android.net.Uri.encode(t)
    }
}
