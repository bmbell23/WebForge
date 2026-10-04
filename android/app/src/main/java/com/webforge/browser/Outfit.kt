package com.webforge.browser

import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
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

    // #195: background Create. Same rules as createForm/createResult in windows/museforge.js,
    // pinned by shared/outfit-create-fixtures.tsv.
    const val PRICE_LABEL = "~\$0.07"

    /** Form body for the from-image POST: all three keys, name/text trimmed (may be empty). */
    fun createForm(src: String?, name: String?, text: String?): String? {
        if (!canSend(src)) return null
        return "src=${enc(src!!)}&name=${enc(name.orEmpty().trim())}&text=${enc(text.orEmpty().trim())}"
    }

    /** What the Studio's answer means: "queued", "login" or "error". Redirects are not followed. */
    fun createResult(status: Int, location: String?): String {
        val path = try { URI(PAGE).resolve(location.orEmpty().trim()).rawPath ?: "" } catch (e: Exception) { "" }
        if (status in 300..399) {
            if (path == "/approvals" || path.startsWith("/approvals/")) return "queued"
            if (path == "/login") return "login"
        }
        return "error"
    }

    /** #195: POST in the background; [done] runs on this thread with (result, detail for an error). */
    fun create(form: String, cookie: String?, done: (result: String, detail: String) -> Unit) {
        Thread {
            try {
                val conn = URL(PAGE).openConnection() as HttpURLConnection
                conn.instanceFollowRedirects = false
                conn.requestMethod = "POST"
                conn.connectTimeout = 10_000
                conn.readTimeout = 30_000
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
                if (cookie != null) conn.setRequestProperty("Cookie", cookie)
                conn.outputStream.use { it.write(form.toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                val result = createResult(code, conn.getHeaderField("Location"))
                var detail = "HTTP $code"
                if (result == "error") {
                    val body = (if (code in 200..399) conn.inputStream else conn.errorStream)
                        ?.bufferedReader()?.use { it.readText() }.orEmpty().trim().take(200)
                    if (body.isNotEmpty()) detail += ": $body"
                }
                conn.disconnect()
                done(result, detail)
            } catch (e: Exception) {
                done("error", e.message ?: e.javaClass.simpleName)
            }
        }.start()
    }
}
