package com.webforge.browser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

data class Persona(val id: String, var name: String, var rules: MutableList<String>, val builtin: Boolean = false)

/**
 * Personas on mobile (#88) — the port of the Windows model (#25). Tabs-only
 * isolation: each Persona owns a tab list, cookies stay shared. URLs matching
 * no rule land in the built-in "Unassigned" Persona so the real ones stay clean.
 *
 * Definitions sync through the same service as bookmarks, so both devices agree.
 */
object Personas {
    const val UNASSIGNED = "unassigned"
    private const val SYNC_URL = "http://100.69.184.113:8013/store/personas"

    private var list: MutableList<Persona>? = null
    private var active: String = UNASSIGNED
    private var updatedAt: Long = 0

    private fun file(c: Context) = File(c.filesDir, "personas.json")

    private fun defaults() = mutableListOf(
        Persona(UNASSIGNED, "Unassigned", mutableListOf(), builtin = true),
        Persona(java.util.UUID.randomUUID().toString(), "Personal", mutableListOf()),
        Persona(java.util.UUID.randomUUID().toString(), "Work", mutableListOf()),
    )

    fun all(c: Context): MutableList<Persona> {
        list?.let { return it }
        val parsed = try {
            val root = JSONObject(file(c).readText())
            updatedAt = root.optLong("updatedAt", 0)
            active = root.optString("active", UNASSIGNED)
            parse(root.optJSONArray("personas") ?: JSONArray())
        } catch (e: Exception) {
            defaults()
        }
        val fixed = if (parsed.isEmpty()) defaults() else parsed
        // Unassigned must always exist.
        if (fixed.none { it.id == UNASSIGNED }) {
            fixed.add(0, Persona(UNASSIGNED, "Unassigned", mutableListOf(), builtin = true))
        }
        list = fixed
        return fixed
    }

    private fun parse(arr: JSONArray): MutableList<Persona> {
        val out = mutableListOf<Persona>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val id = o.optString("id")
            if (id.isEmpty()) continue
            val rules = mutableListOf<String>()
            val r = o.optJSONArray("rules")
            if (r != null) for (j in 0 until r.length()) r.optString(j)?.takeIf { it.isNotBlank() }?.let { rules.add(it) }
            out.add(Persona(id, o.optString("name", "Persona"), rules, o.optBoolean("builtin", id == UNASSIGNED)))
        }
        return out
    }

    private fun save(c: Context, push: Boolean = true) {
        val arr = JSONArray()
        for (p in all(c)) {
            arr.put(
                JSONObject().put("id", p.id).put("name", p.name)
                    .put("builtin", p.builtin).put("rules", JSONArray(p.rules))
            )
        }
        try {
            file(c).writeText(
                JSONObject().put("personas", arr).put("active", active)
                    .put("updatedAt", updatedAt).toString()
            )
        } catch (e: Exception) {
        }
        if (push) pushToServer(c)
    }

    /** #87: ordering matches Windows — Unassigned last, it's a fallback. */
    fun ordered(c: Context): List<Persona> {
        val l = all(c)
        return l.filter { it.id != UNASSIGNED } + l.filter { it.id == UNASSIGNED }
    }

    fun get(c: Context, id: String): Persona? = all(c).find { it.id == id }

    fun activeId(c: Context): String {
        all(c)
        return if (get(c, active) != null) active else UNASSIGNED
    }

    fun setActive(c: Context, id: String) {
        if (get(c, id) == null) return
        active = id
        save(c, push = false) // which Persona is showing is a per-device thing
    }

    fun add(c: Context, name: String): Persona? {
        val clean = name.trim()
        if (clean.isEmpty()) return null
        val p = Persona(java.util.UUID.randomUUID().toString(), clean, mutableListOf())
        all(c).add(p)
        updatedAt = System.currentTimeMillis()
        save(c)
        return p
    }

    fun remove(c: Context, id: String): Boolean {
        if (id == UNASSIGNED) return false
        val ok = all(c).removeAll { it.id == id }
        if (ok) {
            if (active == id) active = UNASSIGNED
            updatedAt = System.currentTimeMillis()
            save(c)
        }
        return ok
    }

    fun update(c: Context, id: String, name: String?, rules: List<String>?) {
        val p = get(c, id) ?: return
        if (id != UNASSIGNED && !name.isNullOrBlank()) p.name = name.trim()
        if (rules != null) {
            p.rules = rules.map { it.trim() }.filter { it.isNotEmpty() }.toMutableList()
        }
        updatedAt = System.currentTimeMillis()
        save(c)
    }

    // --- matching: identical semantics to personas.js (prefix / glob / regex) ---
    private val reCache = HashMap<String, Regex?>()

    private fun compile(pattern: String): Regex? = reCache.getOrPut(pattern) {
        val raw = pattern.trim()
        try {
            val m = Regex("""^/(.*)/([a-z]*)$""").find(raw)
            when {
                m != null -> Regex(m.groupValues[1], RegexOption.IGNORE_CASE)
                raw.contains('*') -> {
                    val body = Regex.escape(raw.trimEnd('*')).let { it } // escaped below instead
                    val escaped = raw.trimEnd('*')
                        .replace(Regex("""([.+?^$\{\}()|\[\]\\])"""), "\\\\$1")
                        .replace("*", ".*")
                    Regex("^$escaped", RegexOption.IGNORE_CASE)
                }
                else -> null
            }
        } catch (e: Exception) {
            null // a bad pattern matches nothing rather than breaking routing
        }
    }

    fun matches(url: String, pattern: String): Boolean {
        if (url.isEmpty() || pattern.isBlank()) return false
        compile(pattern)?.let { return it.containsMatchIn(url) && it.find(url)?.range?.first == 0 }
        val p = pattern.trim().trimEnd('*').lowercase()
        return p.isNotEmpty() && url.lowercase().startsWith(p)
    }

    /** Which Persona claims this URL? Unassigned when nothing does. */
    fun forUrl(c: Context, url: String): String {
        for (p in all(c)) {
            if (p.id == UNASSIGNED) continue
            if (p.rules.any { matches(url, it) }) return p.id
        }
        return UNASSIGNED
    }

    // --- sync: definitions are shared, the active selection is not ---------
    fun sync(c: Context, done: (Boolean) -> Unit = {}) {
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
                all(c)
                if (data != null && data.length() > 0 && remoteAt > updatedAt) {
                    list = parse(data)
                    updatedAt = remoteAt
                    save(c, push = false)
                    ok = true
                }
            } catch (e: Exception) {
            }
            done(ok)
        }.start()
    }

    private fun pushToServer(c: Context) {
        val arr = JSONArray()
        for (p in all(c)) {
            arr.put(
                JSONObject().put("id", p.id).put("name", p.name)
                    .put("builtin", p.builtin).put("rules", JSONArray(p.rules))
            )
        }
        val stamp = updatedAt
        Thread {
            try {
                val conn = URL(SYNC_URL).openConnection() as HttpURLConnection
                conn.requestMethod = "PUT"
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use {
                    it.write(JSONObject().put("data", arr).put("updatedAt", stamp).toString().toByteArray())
                }
                conn.inputStream.use { it.readBytes() }
                conn.disconnect()
            } catch (e: Exception) {
            }
        }.start()
    }
}
