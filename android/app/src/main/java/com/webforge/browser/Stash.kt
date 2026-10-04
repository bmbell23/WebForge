package com.webforge.browser

import android.content.Context
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/**
 * #177: "Add to Stash". The request body and the job-status wording, ported
 * from `windows/stash.js`; the rules and the wording must stay identical.
 *
 * The Dashboard downloads and tags: POST /api/download/stash answers with a job
 * id at once, GET /api/download/stash/<job> reports queued -> downloading ->
 * scanning -> tagging -> done | failed. What the page tells us comes from
 * `shared/stash-page.js` (staged into assets), the same reader Windows runs.
 */
object Stash {
    val KINDS = listOf("media", "video", "gallery")

    /** A gallery is worth offering once the page links a few full-size images. */
    const val GALLERY_MIN = 3

    /** What the page reader returned. Everything is optional, like Windows' `{}`. */
    data class Meta(
        val title: String? = null,
        val performers: List<String> = emptyList(),
        val studio: String? = null,
        val site: String? = null,
        val date: String? = null,
        val tags: List<String> = emptyList(),
        val imageUrls: List<String> = emptyList(),
    )

    class Body(
        val kind: String, val url: String, val pageUrl: String,
        val title: String?, val performers: List<String>, val studio: String?,
        val site: String?, val date: String?, val tags: List<String>,
        val imageUrls: List<String>?, // null unless kind == gallery
    ) {
        // org.json is a stub in JVM unit tests, so the JSON is built by hand.
        fun toJson(): String {
            fun s(v: String?) = if (v == null) "null" else quote(v)
            fun l(v: List<String>) = v.joinToString(",", "[", "]") { quote(it) }
            val meta = StringBuilder()
                .append("\"title\":").append(s(title))
                .append(",\"performers\":").append(l(performers))
                .append(",\"studio\":").append(s(studio))
                .append(",\"site\":").append(s(site))
                .append(",\"date\":").append(s(date))
                .append(",\"tags\":").append(l(tags))
            if (imageUrls != null) meta.append(",\"image_urls\":").append(l(imageUrls))
            return "{\"kind\":${quote(kind)},\"url\":${quote(url)},\"page_url\":${quote(pageUrl)},\"meta\":{$meta}}"
        }
    }

    fun quote(v: String): String {
        val sb = StringBuilder("\"")
        for (c in v) when {
            c == '"' -> sb.append("\\\"")
            c == '\\' -> sb.append("\\\\")
            c == '\n' -> sb.append("\\n")
            c == '\r' -> sb.append("\\r")
            c == '\t' -> sb.append("\\t")
            c < ' ' -> sb.append(String.format("\\u%04x", c.code))
            else -> sb.append(c)
        }
        return sb.append('"').toString()
    }

    /** The Dashboard's stash route, beside the yt-dlp one (same origin). */
    fun endpoint(ytdlpEndpoint: String): String = try {
        URI(ytdlpEndpoint).resolve("/api/download/stash").toString()
    } catch (e: Exception) { "" }

    fun canSend(url: String) = YtDlp.downloadable(url)

    fun isGallery(meta: Meta?) = (meta?.imageUrls?.size ?: 0) >= GALLERY_MIN

    private val ISO_DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")

    /** The POST body, or null for an unknown kind / unsendable url. */
    fun body(kind: String, url: String, pageUrl: String, meta: Meta? = null): Body? {
        if (kind !in KINDS || !canSend(url)) return null
        val m = meta ?: Meta()
        val page = if (canSend(pageUrl)) pageUrl else url
        fun list(v: List<String>) = v.filter { it.isNotBlank() }
        return Body(
            kind, url, page,
            title = m.title?.takeIf { it.isNotEmpty() },
            performers = list(m.performers),
            studio = m.studio?.takeIf { it.isNotEmpty() },
            site = m.site?.takeIf { it.isNotEmpty() } ?: YtDlp.hostOf(page).takeIf { it.isNotEmpty() },
            date = m.date?.takeIf { ISO_DATE.matches(it) },
            tags = list(m.tags),
            imageUrls = if (kind == "gallery") list(m.imageUrls).filter { canSend(it) } else null,
        )
    }

    /** A job status reply. */
    class Status(val state: String?, val error: String?, val path: String?)

    private fun label(kind: String) = when (kind) {
        "media" -> "file"; "video" -> "video"; "gallery" -> "gallery"; else -> "item"
    }

    /** One line for a Toast, from a status reply. */
    fun statusText(kind: String, s: Status?): String {
        val what = label(kind)
        if (s == null || s.state.isNullOrEmpty()) return "Stash: waiting for the $what…"
        return when (s.state) {
            "queued" -> "Stash: $what queued"
            "downloading" -> "Stash: downloading $what…"
            "scanning" -> "Stash: scanning $what…"
            "tagging" -> "Stash: tagging $what…"
            "done" -> "Added $what to Stash" + (s.path?.takeIf { it.isNotEmpty() }?.let { ": " + it.split('/').last() } ?: "")
            "failed" -> "Stash $what failed: " + (s.error?.takeIf { it.isNotEmpty() } ?: "unknown error").take(300)
            else -> "Stash: ${s.state}"
        }
    }

    fun finished(s: Status?) = s != null && (s.state == "done" || s.state == "failed")

    // --- the page reader (runtime only; org.json is real on a device) ---

    @Volatile private var readerCache: String? = null

    /** shared/stash-page.js, staged into assets by the APK build. "" if missing. */
    fun readerSource(ctx: Context): String = readerCache ?: try {
        ctx.assets.open("stash-page.js").bufferedReader().use { it.readText() }.also { readerCache = it }
    } catch (e: Exception) { "" }

    /** The reader's evaluateJavascript result ("null" or a JSON object) -> Meta; empty Meta if unreadable. */
    fun parseMeta(json: String?): Meta {
        if (json.isNullOrBlank() || json == "null") return Meta()
        return try {
            val o = org.json.JSONObject(json)
            fun str(k: String) = if (o.isNull(k)) null else o.optString(k).takeIf { it.isNotEmpty() }
            fun list(k: String): List<String> {
                val a = o.optJSONArray(k) ?: return emptyList()
                return (0 until a.length()).mapNotNull { a.optString(it).takeIf { s -> s.isNotEmpty() } }
            }
            Meta(str("title"), list("performers"), str("studio"), str("site"), str("date"), list("tags"), list("image_urls"))
        } catch (e: Exception) { Meta() }
    }

    private fun status(text: String): Status? = try {
        val o = org.json.JSONObject(text)
        fun str(k: String) = if (o.isNull(k)) null else o.optString(k)
        Status(str("state"), str("error"), str("path"))
    } catch (e: Exception) { null }

    private const val POLL_MS = 3_000L
    private const val GIVE_UP_MS = 60 * 60 * 1000L

    /**
     * POST, then poll every ~3 s until done/failed (60 min cap), on its own
     * thread. [done] runs on that thread with the final line; it holds no tab.
     */
    fun send(endpoint: String, kind: String, body: Body, done: (ok: Boolean, message: String) -> Unit) {
        Thread {
            try {
                val (code, text) = http("POST", endpoint, body.toJson())
                val o = try { org.json.JSONObject(text) } catch (e: Exception) { null }
                val job = o?.optString("job").orEmpty()
                if (code !in 200..299 || o == null || !o.optBoolean("ok") || job.isEmpty()) {
                    val err = o?.optString("error").orEmpty().ifEmpty { "HTTP $code" }
                    done(false, "Stash ${label(kind)} failed: " + err.take(300))
                    return@Thread
                }
                val deadline = System.currentTimeMillis() + GIVE_UP_MS
                var errors = 0
                while (System.currentTimeMillis() < deadline) {
                    Thread.sleep(POLL_MS)
                    val s = try {
                        val (c, t) = http("GET", "$endpoint/$job", null)
                        if (c in 200..299) status(t) else null
                    } catch (e: Exception) { null }
                    if (s == null) {
                        if (++errors >= 20) { done(false, "Stash ${label(kind)} failed: lost contact with the Dashboard"); return@Thread }
                        continue
                    }
                    errors = 0
                    if (finished(s)) { done(s.state == "done", statusText(kind, s)); return@Thread }
                }
                done(false, "Stash ${label(kind)} failed: gave up waiting after 60 minutes")
            } catch (e: Exception) {
                done(false, "Stash ${label(kind)} failed: ${e.message ?: e.javaClass.simpleName}")
            }
        }.start()
    }

    private fun http(method: String, url: String, payload: String?): Pair<Int, String> {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 10_000
            conn.readTimeout = 30_000
            if (payload != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(payload.toByteArray()) }
            }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() } ?: ""
            return code to text
        } finally { conn.disconnect() }
    }
}
