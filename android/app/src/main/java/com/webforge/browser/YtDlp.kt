package com.webforge.browser

import android.content.Context
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/**
 * #156: send the current page to the Dashboard's yt-dlp.
 *
 * The Dashboard picks the folder from {url, format, adult, short, kids}; all we
 * decide is that body, and it must match Windows (`windows/ytdlp.js`) exactly.
 * Both read `shared/ytdlp-sites.json` and are pinned by
 * `shared/ytdlp-fixtures.tsv` (see YtDlpTest).
 */
object YtDlp {
    class Sites(val endpoint: String, val adult: List<String>, val short: List<String>)

    data class Body(
        val url: String, val format: String,
        val adult: Boolean, val short: Boolean, val kids: Boolean,
    ) {
        fun toJson(): String {
            val u = url.replace("\\", "\\\\").replace("\"", "\\\"")
            return """{"url":"$u","format":"$format","adult":$adult,"short":$short,"kids":$kids}"""
        }
    }

    /**
     * A deliberately tiny reader for our own flat file. Not org.json: that is a
     * stub in JVM unit tests, and the test must read the real shared file.
     */
    fun parse(json: String): Sites {
        fun str(key: String) =
            Regex("\"$key\"\\s*:\\s*\"([^\"]*)\"").find(json)?.groupValues?.get(1) ?: ""
        fun list(key: String): List<String> {
            val body = Regex("\"$key\"\\s*:\\s*\\[([^\\]]*)\\]").find(json)?.groupValues?.get(1) ?: return emptyList()
            return Regex("\"([^\"]+)\"").findAll(body).map { it.groupValues[1].lowercase() }.toList()
        }
        return Sites(str("endpoint"), list("adult"), list("short"))
    }

    @Volatile private var cached: Sites? = null

    /** Staged into assets from shared/ by the APK build, like newtab.html. */
    fun sites(ctx: Context): Sites = cached ?: try {
        parse(ctx.assets.open("ytdlp-sites.json").bufferedReader().use { it.readText() }).also { cached = it }
    } catch (e: Exception) {
        // #176: not cached, so one failed read can't switch adult-tab closing
        // off for the rest of the process.
        Sites("", emptyList(), emptyList())
    }

    fun hostOf(url: String): String = try {
        val u = URI(url.trim())
        val scheme = u.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") "" else (u.host ?: "").lowercase().removePrefix("www.")
    } catch (e: Exception) { "" }

    /** Subdomains count (de.pornhub.com, i.imgur.com); look-alikes don't. */
    private fun onList(host: String, list: List<String>) =
        host.isNotEmpty() && list.any { host == it || host.endsWith(".$it") }

    fun downloadable(url: String) = hostOf(url).isNotEmpty()

    /** #176: an adult tab closes the moment you leave it, and never syncs or restores. */
    fun isAdult(sites: Sites, url: String) = onList(hostOf(url), sites.adult)

    /** What the picker starts with: (adult, short). */
    fun defaults(sites: Sites, url: String): Pair<Boolean, Boolean> {
        val h = hostOf(url)
        return onList(h, sites.adult) to onList(h, sites.short)
    }

    /**
     * Kids and Adult are exclusive (Kids wins, it's the one you ticked on
     * purpose), and audio has no adult/short folders, so both are cleared.
     */
    fun body(
        sites: Sites, url: String, format: String, kids: Boolean,
        adult: Boolean? = null, short: Boolean? = null,
    ): Body {
        val fmt = if (format == "audio") "audio" else "video"
        val (dAdult, dShort) = defaults(sites, url)
        var a = adult ?: dAdult
        var s = short ?: dShort
        if (kids || fmt == "audio") { a = false; s = false }
        return Body(url, fmt, a, s, kids)
    }

    /**
     * POST in the background. The Dashboard only answers once yt-dlp has
     * finished (up to 10 minutes), so [done] may run much later, on this thread.
     */
    fun send(endpoint: String, body: Body, done: (ok: Boolean, message: String) -> Unit) {
        Thread {
            try {
                val conn = URL(endpoint).openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.connectTimeout = 10_000
                conn.readTimeout = 11 * 60 * 1000 // the server gives up at 10
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toJson().toByteArray()) }
                val code = conn.responseCode
                val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader()?.use { it.readText() } ?: ""
                conn.disconnect()
                fun field(k: String) = Regex("\"$k\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")
                    .find(text)?.groupValues?.get(1)?.replace("\\u2014", "—")
                val success = Regex("\"success\"\\s*:\\s*true").containsMatchIn(text)
                if (code in 200..299 && success) {
                    done(true, field("message") ?: "Download complete")
                } else {
                    done(false, "yt-dlp failed: " + (field("error") ?: "HTTP $code").take(300))
                }
            } catch (e: Exception) {
                done(false, "yt-dlp failed: ${e.message ?: e.javaClass.simpleName}")
            }
        }.start()
    }
}
