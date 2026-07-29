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
    private var updatedAt: Long = 0 // #85: last-write-wins stamp, as on Windows

    private fun file(c: Context) = File(c.filesDir, "bookmarks.json")

    fun all(c: Context): List<Bookmark> {
        cache?.let { return it }
        val parsed = try {
            val root = JSONObject(file(c).readText())
            updatedAt = root.optLong("updatedAt", 0)
            parse(root.optJSONArray("bookmarks") ?: JSONArray())
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
            file(c).writeText(
                JSONObject().put("bookmarks", arr).put("updatedAt", updatedAt).toString()
            )
        } catch (e: Exception) {
            // cache-only this run; next sync tries again
        }
    }

    // --- #85: the phone can edit bookmarks now, not just read them ---------

    /** Apply a local change, then push it so the desktop picks it up. */
    private fun mutate(c: Context, newList: List<Bookmark>) {
        cache = newList
        updatedAt = System.currentTimeMillis() // we are now the newest copy
        save(c, newList)
        push(c)
    }

    fun update(c: Context, id: String, title: String, url: String, folder: String) {
        if (url.isBlank()) return
        mutate(c, all(c).map {
            if (it.id == id) Bookmark(it.id, title.ifBlank { url }, url, folder) else it
        })
    }

    fun remove(c: Context, id: String) {
        mutate(c, all(c).filterNot { it.id == id })
    }

    /** Send the local set to the sync service. Silent when off the tailnet. */
    private fun push(c: Context) {
        val snapshot = all(c)
        val stamp = updatedAt
        Thread {
            try {
                val arr = JSONArray()
                for (b in snapshot) {
                    arr.put(
                        JSONObject().put("id", b.id).put("title", b.title)
                            .put("url", b.url).put("folder", b.folder)
                    )
                }
                val body = JSONObject().put("data", arr).put("updatedAt", stamp).toString()
                val conn = URL(SYNC_URL).openConnection() as HttpURLConnection
                conn.requestMethod = "PUT"
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toByteArray()) }
                conn.inputStream.use { it.readBytes() }
                conn.disconnect()
            } catch (e: Exception) {
                // off the tailnet — the local copy stands and syncs later
            }
        }.start()
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
                val root = JSONObject(body)
                val remoteAt = root.optLong("updatedAt", 0)
                val data = root.optJSONArray("data")
                // #85: last-write-wins — never overwrite newer local edits.
                all(c) // ensure updatedAt is loaded from disk
                if (data != null && data.length() > 0 && remoteAt >= updatedAt) {
                    val list = parse(data)
                    cache = list
                    updatedAt = remoteAt
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
