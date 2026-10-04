package com.webforge.browser

import java.net.URI
import java.net.URLEncoder

/**
 * #181: Create Outfit — the Studio's outfit-from-image page, handed an image
 * plus an optional name and description. The Studio confirms and spends; we
 * only build the address. Same rules as `windows/museforge.js`, pinned by
 * `shared/outfit-fixtures.tsv`.
 */
object Outfit {
    const val PAGE = "http://100.69.184.113:8005/library/outfit/from-image"

    /** Only an absolute http(s) image; the Studio can't fetch data:, blob: or file:. */
    fun canSend(src: String?): Boolean = try {
        val s = URI(src ?: "").scheme?.lowercase()
        s == "http" || s == "https"
    } catch (e: Exception) {
        // URI is stricter than the browser (a raw space throws); fall back to the scheme.
        val s = src.orEmpty().substringBefore(':', "").lowercase()
        s == "http" || s == "https"
    }

    /** #191: the Studio's post-"Make outfit" page, /approvals[/...] on the Studio's own origin. */
    fun isDone(url: String): Boolean = try {
        val u = URI(url.trim())
        val p = URI(PAGE)
        fun port(x: URI) = if (x.port >= 0) x.port else if (x.scheme?.lowercase() == "https") 443 else 80
        u.scheme?.lowercase() == p.scheme && u.host?.lowercase() == p.host && port(u) == port(p) &&
            (u.rawPath == "/approvals" || (u.rawPath ?: "").startsWith("/approvals/"))
    } catch (e: Exception) { false }

    private fun enc(v: String) = URLEncoder.encode(v, "UTF-8")

    fun url(src: String?, name: String?, text: String?): String? {
        if (!canSend(src)) return null
        val q = StringBuilder("src=").append(enc(src!!))
        name?.trim()?.takeIf { it.isNotEmpty() }?.let { q.append("&name=").append(enc(it)) }
        text?.trim()?.takeIf { it.isNotEmpty() }?.let { q.append("&text=").append(enc(it)) }
        return "$PAGE?$q"
    }
}
