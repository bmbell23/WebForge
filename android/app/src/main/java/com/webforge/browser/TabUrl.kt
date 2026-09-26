package com.webforge.browser

import java.net.URI

/**
 * #152: deciding whether two URLs are "the same page", for tab de-duplication.
 *
 * The Android port of `windows/taburl.js`. Windows got this in #107; Android
 * never did, and the consequence was exactly what #107 was written to stop:
 * `TabSync`'s adoption loop compared URLs with `it.url == url` — exact string
 * equality — so the same page arriving with a trailing slash, a fragment or a
 * changed query string was adopted as a NEW tab, every sync cycle. That is the
 * 16 copies of Charles Schwab.
 *
 * The two implementations reconcile against each other through the sync
 * service, so they must agree. They are held in step by a shared fixture set at
 * `shared/taburl-fixtures.tsv`, read by both this class's JVM test and
 * `windows/taburl.test.js`. A case added on either side fails the other.
 *
 * Kept deliberately free of Android types so it runs as a plain JVM test — the
 * same split as [UserAgent] and [UpdateCheck].
 */
object TabUrl {

    /**
     * Reduce a URL to a comparison key. Equal keys mean "the same tab".
     *
     * Normalised away: scheme (http/https), a leading `www.`, default ports, a
     * trailing slash, and plain `#anchor` fragments.
     * Kept significant: host, non-default port, path, the whole query string,
     * and `#/hash-routes`.
     *
     * The `#/` rule is the same deliberate heuristic the Windows side documents:
     * hash-routed apps use `#/path`, so `app#/dashboard` and `app#/settings` are
     * different pages, while `docs#install` and `docs#intro` are two positions in
     * one document. An app routing on bare `#names` is treated as one page —
     * wrong, but the rarer case.
     *
     * Anything that is not http(s) — file://, about:, view-source: — comes back
     * trimmed but otherwise untouched, so internal pages never merge together.
     */
    fun canonical(url: String?): String {
        if (url == null) return ""
        val raw = url.trim()
        if (raw.isEmpty()) return ""

        val uri = try {
            URI(raw)
        } catch (e: Exception) {
            return raw // not parseable: compare literally rather than guess
        }
        // A missing scheme is the Kotlin equivalent of `new URL(x)` throwing in
        // JS: URI("not a url") parses happily with a null scheme, so this is the
        // check that keeps the two sides in step.
        val scheme = uri.scheme?.lowercase() ?: return raw
        if (scheme != "http" && scheme != "https") return raw
        val host = uri.host?.lowercase()?.removePrefix("www.") ?: return raw

        val port = uri.port
        val defaultPort =
            port == -1 || (scheme == "http" && port == 80) || (scheme == "https" && port == 443)
        val portPart = if (defaultPort) "" else ":$port"

        // "/docs/" and "/docs" are one page. Raw forms throughout, so escaping is
        // preserved exactly as the JS `pathname`/`search`/`hash` do.
        val path = (uri.rawPath ?: "").trimEnd('/')
        val query = uri.rawQuery?.let { if (it.isEmpty()) "" else "?$it" } ?: ""
        // rawFragment excludes the '#', so a route is "/..." here where the JS
        // sees "#/...".
        val fragment = uri.rawFragment?.let { if (it.startsWith("/")) "#$it" else "" } ?: ""

        return "$host$portPart$path$query$fragment"
    }

    /** True when both URLs denote the same tab. Empty/unknown never matches. */
    fun sameTab(a: String?, b: String?): Boolean {
        val ka = canonical(a)
        return ka.isNotEmpty() && ka == canonical(b)
    }

    /**
     * Index of the tab already showing [url], or -1 to open a new one.
     *
     * Android's equivalent of `pickTab`. Returns an index rather than an id
     * because MainActivity keys tabs positionally.
     */
    fun indexOf(urls: List<String?>, url: String?): Int {
        val key = canonical(url)
        if (key.isEmpty()) return -1
        for (i in urls.indices) {
            if (canonical(urls[i]) == key) return i
        }
        return -1
    }
}
