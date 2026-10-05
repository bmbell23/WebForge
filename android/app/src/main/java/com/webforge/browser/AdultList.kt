package com.webforge.browser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

/**
 * #203: your own adult-site list on top of the built-in one in
 * shared/ytdlp-sites.json. A port of `windows/adultlist.js`; normalize() is
 * pinned by shared/adult-entry-fixtures.tsv. Synced through the `adult` key.
 */
object AdultList {
    private const val SYNC_URL = "http://100.69.184.113:8013/store/adult"
    private const val PREFS = "adult_list"

    data class User(val added: List<String>, val removed: List<String>)

    private val HOST = Regex("^[a-z0-9-]+(\\.[a-z0-9-]+)*\\z")
    private val SCHEME = Regex("^[a-z][a-z0-9+.-]*://")
    private val TAIL = Regex("[/?#].*\\z")
    private val USERINFO = Regex("^[^@]*@")
    private val HOSTPORT = Regex("^(.*?)(?::(\\d{1,5}))?\\z")
    private val ORIGIN = Regex(":\\d+\\z")

    fun normalize(entry: String?): String? {
        var s = (entry ?: "").trim().lowercase(Locale.ROOT)
        s = SCHEME.replaceFirst(s, "")
        s = TAIL.replaceFirst(s, "")
        s = USERINFO.replaceFirst(s, "")
        val m = HOSTPORT.find(s) ?: return null
        var host = m.groupValues[1].removeSuffix(".")
        val port = m.groups[2]?.value
        if (port != null) {
            val n = port.toInt()
            if (n < 1 || n > 65535) return null
            if (host == "*") return "*:$n"
            if (!HOST.matches(host)) return null
            return "$host:$n"
        }
        host = host.removePrefix("www.")
        if (!HOST.matches(host) || (!host.contains('.') && host != "localhost")) return null
        return host
    }

    fun isOrigin(e: String) = ORIGIN.containsMatchIn(e)

    fun clean(added: List<String>, removed: List<String>): User {
        val rem = removed.mapNotNull { normalize(it) }.distinct()
        val add = added.mapNotNull { normalize(it) }.distinct().filter { it !in rem }
        return User(add, rem)
    }

    fun effective(base: YtDlp.Sites, added: List<String>, removed: List<String>): YtDlp.Sites {
        val u = clean(added, removed)
        fun merge(list: List<String>, mine: List<String>) =
            (list.filter { it !in u.removed } + mine).distinct()
        return YtDlp.Sites(
            base.endpoint,
            merge(base.adult, u.added.filter { !isOrigin(it) }),
            base.short,
            base.adultWords,
            merge(base.adultOrigins, u.added.filter { isOrigin(it) }),
        )
    }

    // --- storage ---
    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun strings(arr: JSONArray?): List<String> =
        if (arr == null) emptyList() else (0 until arr.length()).mapNotNull { arr.optString(it, null) }

    private fun parse(json: String?): User = try {
        val o = JSONObject(json ?: "")
        clean(strings(o.optJSONArray("added")), strings(o.optJSONArray("removed")))
    } catch (e: Exception) {
        User(emptyList(), emptyList())
    }

    private fun toJson(u: User): JSONObject =
        JSONObject().put("added", JSONArray(u.added)).put("removed", JSONArray(u.removed))

    fun load(c: Context): User = parse(prefs(c).getString("data", null))

    private fun updatedAt(c: Context) = prefs(c).getLong("updatedAt", 0)

    @Synchronized
    private fun store(c: Context, u: User, at: Long) {
        prefs(c).edit().putString("data", toJson(u).toString()).putLong("updatedAt", at).apply()
        YtDlp.invalidate()
    }

    private fun write(c: Context, u: User) {
        val at = System.currentTimeMillis()
        store(c, clean(u.added, u.removed), at)
        push(c)
    }

    @Synchronized
    fun add(c: Context, entry: String): Boolean {
        val e = normalize(entry) ?: return false
        val u = load(c)
        val removed = u.removed.filter { it != e } // a switched-off built-in comes back on (same as Windows int:add-adult)
        val added = if (e in YtDlp.builtins(c)) u.added else (u.added + e).distinct()
        write(c, User(added, removed))
        return true
    }

    @Synchronized
    fun remove(c: Context, entry: String) {
        val u = load(c)
        write(c, User(u.added.filter { it != entry }, u.removed))
    }

    @Synchronized
    fun setBuiltinOff(c: Context, entry: String, off: Boolean) {
        val u = load(c)
        write(c, User(u.added, if (off) (u.removed + entry).distinct() else u.removed.filter { it != entry }))
    }

    // --- sync ---
    fun sync(c: Context, done: (Boolean) -> Unit = {}) {
        Thread {
            var pulled = false
            try {
                val conn = URL(SYNC_URL).openConnection() as HttpURLConnection
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                val body = conn.inputStream.bufferedReader().readText()
                conn.disconnect()
                val root = JSONObject(body)
                val remoteAt = root.optLong("updatedAt", 0)
                val data = root.optJSONObject("data")
                val localAt = updatedAt(c)
                // A fresh install is stamped 0, so it pulls but never pushes (#151); an edit that empties the list still pushes.
                if (data != null && remoteAt > localAt) {
                    store(c, parse(data.toString()), remoteAt)
                    pulled = true
                } else if (localAt > remoteAt) {
                    push(c)
                }
            } catch (e: Exception) {
            }
            done(pulled)
        }.start()
    }

    private fun push(c: Context) {
        val data = toJson(load(c))
        val stamp = updatedAt(c)
        Thread {
            try {
                val conn = URL(SYNC_URL).openConnection() as HttpURLConnection
                conn.requestMethod = "PUT"
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use {
                    it.write(JSONObject().put("data", data).put("updatedAt", stamp).toString().toByteArray())
                }
                conn.inputStream.use { it.readBytes() }
                conn.disconnect()
            } catch (e: Exception) {
            }
        }.start()
    }
}
