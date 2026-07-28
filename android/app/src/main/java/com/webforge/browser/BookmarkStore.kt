package com.webforge.browser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

data class Bookmark(val id: String, val title: String, val url: String, val folder: String)

/**
 * Bookmarks on mobile (#52): a local cache that is ALWAYS the thing we render,
 * refreshed opportunistically from the sync service. Off the tailnet the pull
 * simply fails and the cache keeps working — same offline-first contract as
 * the Windows client.
 */
object BookmarkStore {
    private const val SYNC_URL = "http://100.69.184.113:8013/store/bookmarks"
    private var cache: List<Bookmark>? = null

    private fun file(c: Context) = File(c.filesDir, "bookmarks.json")

    fun all(c: Context): List<Bookmark> {
        cache?.let { return it }
        val parsed = try {
            parse(JSONObject(file(c).readText()).optJSONArray("bookmarks") ?: JSONArray())
        } catch (e: Exception) {
            emptyList()
        }
        cache = parsed
        return parsed
    }

    private fun parse(arr: JSONArray): List<Bookmark> {
        val out = ArrayList<Bookmark>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val url = o.optString("url")
            if (url.isNullOrEmpty()) continue
            out.add(
                Bookmark(
                    id = o.optString("id", url),
                    title = o.optString("title").ifEmpty { url },
                    url = url,
                    folder = o.optString("folder", ""),
                )
            )
        }
        return out
    }

    private fun save(c: Context, list: List<Bookmark>) {
        val arr = JSONArray()
        for (b in list) {
            arr.put(
                JSONObject()
                    .put("id", b.id)
                    .put("title", b.title)
                    .put("url", b.url)
                    .put("folder", b.folder)
            )
        }
        try {
            file(c).writeText(JSONObject().put("bookmarks", arr).toString())
        } catch (e: Exception) {
            // cache-only this run; next sync tries again
        }
    }

    /** Pull from the server on a background thread; [done] runs on that thread. */
    fun sync(c: Context, done: (Boolean) -> Unit) {
        Thread {
            var ok = false
            try {
                val conn = URL(SYNC_URL).openConnection() as HttpURLConnection
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                val body = conn.inputStream.bufferedReader().readText()
                conn.disconnect()
                val data = JSONObject(body).optJSONArray("data")
                if (data != null && data.length() > 0) {
                    val list = parse(data)
                    cache = list
                    save(c, list)
                    ok = true
                }
            } catch (e: Exception) {
                // off the tailnet / server down — the local cache stands in
            }
            done(ok)
        }.start()
    }

    /** Folder paths that exist, sorted; "" (root) excluded. */
    fun folders(c: Context): List<String> =
        all(c).map { it.folder }.filter { it.isNotEmpty() }.distinct().sorted()
}
