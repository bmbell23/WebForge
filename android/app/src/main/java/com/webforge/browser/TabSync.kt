package com.webforge.browser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

// #298: another device's open tab, and one device's worth of them for the
// "From other devices" list (all Personas flattened; `at` is when it was opened).
data class OtherTab(val title: String, val url: String, val at: Long)
data class DeviceFacts(val name: String, val at: Long, val open: List<OtherTab>)
data class OtherDeviceGroup(val device: String, val at: Long, val tabs: List<OtherTab>)

/**
 * Cross-device tabs (#57), phase 1.
 *
 * Each device publishes per-URL *facts* under a stable device id — when it
 * opened a URL, and when it closed one — rather than a snapshot, because a
 * snapshot cannot tell "closed on the other device" apart from "opened here
 * while that device was offline". A URL is open iff its open stamp beats every
 * tombstone for it, which reconciles correctly after either device has been off
 * the tailnet for a while.
 */
object TabSync {
    private const val URL_STR = "http://100.69.184.113:8013/store/tabs"
    // #298: a device silent this long is forgotten; close facts keep their own TTL.
    // Mirrors windows/tabsync.js — the two must agree.
    const val STALE_MS = 3L * 24 * 3600 * 1000
    const val TOMBSTONE_TTL = 30L * 24 * 3600 * 1000

    // #298: other devices' open tabs, kept only to be LISTED. This device no
    // longer adopts them (it used to carry the union of every device's tabs).
    private var otherDevices: Map<String, DeviceFacts> = emptyMap()
    // #57 phase 2: merged close facts per persona — closed[url]=at.
    // #95: REBUILT from scratch on every sync. These used to accumulate forever.
    var mergedClosed: MutableMap<String, MutableMap<String, Long>> = HashMap()
    private val tombstones = HashMap<String, Long>() // url -> when WE closed it

    fun recordClose(url: String) {
        if (url.isNotBlank()) tombstones[url] = System.currentTimeMillis()
    }

    /**
     * #95: every tombstone we know of, ours included, flattened across Personas.
     * Persona ids diverge between devices, so a per-Persona lookup can miss a
     * close entirely — a URL is a URL.
     */
    fun closedAt(url: String): Long {
        // #152: compare CANONICALLY, not by exact string. Closing a tab on
        // Windows records a tombstone for the URL Windows held; the phone's copy
        // is often a variant (trailing slash, fragment, http vs https), so an
        // exact lookup never matched and the close was never honoured. That is
        // why the phantom Schwab tabs outlived the Windows tabs they came from.
        val key = TabUrl.canonical(url)
        if (key.isEmpty()) return 0L
        var at = 0L
        for ((u, t) in tombstones) if (TabUrl.canonical(u) == key && t > at) at = t
        for (m in mergedClosed.values) {
            for ((u, t) in m) if (TabUrl.canonical(u) == key && t > at) at = t
        }
        return at
    }

    fun forgetClose(url: String) {
        tombstones.remove(url)
    }

    private fun prefs(c: Context) = c.getSharedPreferences("webforge", Context.MODE_PRIVATE)

    fun deviceId(c: Context): String {
        val existing = prefs(c).getString("deviceId", null)
        if (existing != null) return existing
        val id = "android-" + java.util.UUID.randomUUID().toString().take(8)
        prefs(c).edit().putString("deviceId", id).apply()
        return id
    }

    /** #298: ids of OTHER devices silent for more than [maxAgeMs]; [me] is never stale. */
    fun staleDeviceIds(ats: Map<String, Long>, now: Long, me: String, maxAgeMs: Long = STALE_MS): Set<String> =
        ats.filter { (id, at) -> id != me && now - at > maxAgeMs }.keys

    /**
     * #298: the close facts a silent device keeps. They live inside its entry and a
     * live device that was offline may not have applied them yet, so they stay for
     * their normal TTL; its open facts are what get shed.
     */
    fun liveClosed(closed: Map<String, Long>, now: Long): Map<String, Long> =
        closed.filter { now - it.value <= TOMBSTONE_TTL }

    /**
     * #298: the "From other devices" list — groups and tabs newest first. Skips this
     * device, silent devices (when [now] is given), adult URLs and URLs already open
     * here (canonical compare, #152). Same-named devices merge; a URL lists once.
     */
    fun otherDeviceTabs(
        devices: Map<String, DeviceFacts>, me: String, openUrls: List<String>,
        isAdult: (String) -> Boolean, now: Long? = null, maxAgeMs: Long = STALE_MS
    ): List<OtherDeviceGroup> {
        val open = openUrls.map { TabUrl.canonical(it) }.toSet()
        val groups = LinkedHashMap<String, LinkedHashMap<String, OtherTab>>()
        for ((id, dev) in devices) {
            if (id == me) continue
            if (now != null && now - dev.at > maxAgeMs) continue
            for (t in dev.open) {
                val key = TabUrl.canonical(t.url)
                if (key in open || isAdult(t.url)) continue
                val g = groups.getOrPut(dev.name) { LinkedHashMap() }
                val prev = g[key]
                if (prev == null || t.at > prev.at) g[key] = t
            }
        }
        return groups.map { (name, byUrl) ->
            val tabs = byUrl.values.sortedByDescending { it.at }
            OtherDeviceGroup(name, tabs.first().at, tabs)
        }.sortedByDescending { it.at }
    }

    /** #298: what this device would list right now. */
    fun otherDeviceList(c: Context, openUrls: List<String>, isAdult: (String) -> Boolean): List<OtherDeviceGroup> =
        otherDeviceTabs(otherDevices, deviceId(c), openUrls, isAdult, System.currentTimeMillis())

    /**
     * Publish [local] (personaId -> tabs) and refresh what other devices show.
     * Runs entirely off the main thread; silent when the server is unreachable.
     */
    fun sync(c: Context, local: Map<String, List<Triple<String, String, Long>>>, done: () -> Unit = {}) {
        val me = deviceId(c)
        Thread {
            try {
                val conn = URL(URL_STR).openConnection() as HttpURLConnection
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                val body = conn.inputStream.bufferedReader().readText()
                conn.disconnect()

                val root = JSONObject(body).optJSONObject("data") ?: JSONObject()
                val devs = root.optJSONObject("devices") ?: JSONObject()

                // #95: merge close facts from EVERY device, this one included — our own
                // tombstones have to be in the merged view or we re-open the tab we
                // just closed. #298: open facts only feed the display list, and only
                // for OTHER devices that are still live.
                val now = System.currentTimeMillis()
                val ats = HashMap<String, Long>()
                for (id in devs.keys()) ats[id] = devs.optJSONObject(id)?.optLong("at", 0) ?: 0L
                val stale = staleDeviceIds(ats, now, me)
                val parsed = HashMap<String, DeviceFacts>()
                val closed = HashMap<String, MutableMap<String, Long>>()
                for (id in devs.keys()) {
                    val d = devs.optJSONObject(id) ?: continue
                    val tabsOf = ArrayList<OtherTab>()
                    val ps = d.optJSONObject("personas") ?: JSONObject()
                    for (pid in ps.keys()) {
                        val block = ps.optJSONObject(pid) ?: continue
                        if (id != me && id !in stale) {
                            val openObj = block.optJSONObject("open") ?: JSONObject()
                            for (u in openObj.keys()) {
                                val o = openObj.optJSONObject(u) ?: continue
                                tabsOf.add(OtherTab(o.optString("title", u), u, o.optLong("at", 0)))
                            }
                        }
                        val closedObj = block.optJSONObject("closed") ?: JSONObject()
                        for (u in closedObj.keys()) {
                            val m = closed.getOrPut(pid) { HashMap() }
                            val at = closedObj.optLong(u, 0)
                            if (at > (m[u] ?: 0)) m[u] = at
                        }
                    }
                    if (id != me && id !in stale) parsed[id] = DeviceFacts(d.optString("name", id), ats[id] ?: 0L, tabsOf)
                }
                mergedClosed = closed
                otherDevices = parsed

                // #298: shed silent devices from what we write back — open facts go,
                // close facts inside their TTL stay, and an entry with none is dropped.
                for (id in stale) {
                    val d = devs.optJSONObject(id) ?: continue
                    val ps = d.optJSONObject("personas") ?: JSONObject()
                    val kept = JSONObject()
                    for (pid in ps.keys()) {
                        val co = ps.optJSONObject(pid)?.optJSONObject("closed") ?: continue
                        val cm = HashMap<String, Long>()
                        for (u in co.keys()) cm[u] = co.optLong(u, 0)
                        val live = liveClosed(cm, now)
                        if (live.isNotEmpty()) {
                            val lo = JSONObject()
                            for ((u, t) in live) lo.put(u, t)
                            kept.put(pid, JSONObject().put("closed", lo))
                        }
                    }
                    if (kept.length() == 0) devs.remove(id) else d.put("personas", kept)
                }

                // Publish ours alongside, leaving other devices' entries intact.
                // Publish facts: what we have open (with when) and what we closed.
                val mine = JSONObject()
                for ((pid, list) in local) {
                    val openObj = JSONObject()
                    for ((url, title, at) in list) {
                        openObj.put(url, JSONObject().put("title", title).put("at", at).put("dev", me))
                    }
                    mine.put(pid, JSONObject().put("open", openObj))
                }
                val cutoff = System.currentTimeMillis() - 30L * 24 * 3600 * 1000
                tombstones.entries.removeAll { it.value < cutoff }
                for ((url, at) in tombstones) {
                    val pid = Personas.forUrl(c, url)
                    val block = mine.optJSONObject(pid) ?: JSONObject().also { mine.put(pid, it) }
                    val closedObj = block.optJSONObject("closed") ?: JSONObject().also { block.put("closed", it) }
                    closedObj.put(url, at)
                }
                devs.put(
                    me,
                    JSONObject().put("name", "Phone").put("personas", mine)
                        .put("at", System.currentTimeMillis())
                )
                val out = JSONObject()
                    .put("data", JSONObject().put("devices", devs))
                    .put("updatedAt", System.currentTimeMillis())

                val put = URL(URL_STR).openConnection() as HttpURLConnection
                put.requestMethod = "PUT"
                put.connectTimeout = 5000
                put.readTimeout = 5000
                put.doOutput = true
                put.setRequestProperty("Content-Type", "application/json")
                put.outputStream.use { it.write(out.toString().toByteArray()) }
                put.inputStream.use { it.readBytes() }
                put.disconnect()
            } catch (e: Exception) {
                // off the tailnet — we publish again next cycle
            }
            done()
        }.start()
    }
}
