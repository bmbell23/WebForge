package com.webforge.browser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class RemoteTab(val title: String, val url: String)
data class RemoteDevice(val name: String, val tabs: List<RemoteTab>)

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
    private var devices: Map<String, Map<String, List<RemoteTab>>> = emptyMap()
    private var names: Map<String, String> = emptyMap()
    // #57 phase 2: merged facts per persona — open[url]=(title, at, device),
    // closed[url]=at. #95: REBUILT from scratch on every sync. These used to
    // accumulate forever, so a URL that had once been open was re-adopted on
    // every cycle long after every device had stopped publishing it.
    var mergedOpen: MutableMap<String, MutableMap<String, Triple<String, Long, String>>> = HashMap()
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
        var at = tombstones[url] ?: 0L
        for (m in mergedClosed.values) m[url]?.let { if (it > at) at = it }
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

    /** Other devices' tabs in [personaId]. */
    fun remoteFor(personaId: String): List<RemoteDevice> =
        devices.mapNotNull { (id, byPersona) ->
            val list = byPersona[personaId].orEmpty()
            if (list.isEmpty()) null else RemoteDevice(names[id] ?: id, list)
        }

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

                // #95: merge facts from EVERY device, this one included — our own
                // tombstones have to be in the merged view or we re-adopt the tab
                // we just closed. Only the *display* list ("On Windows") skips us.
                val parsedDevices = HashMap<String, Map<String, List<RemoteTab>>>()
                val parsedNames = HashMap<String, String>()
                val open = HashMap<String, MutableMap<String, Triple<String, Long, String>>>()
                val closed = HashMap<String, MutableMap<String, Long>>()
                for (id in devs.keys()) {
                    val d = devs.optJSONObject(id) ?: continue
                    val byPersona = HashMap<String, List<RemoteTab>>()
                    val ps = d.optJSONObject("personas") ?: JSONObject()
                    for (pid in ps.keys()) {
                        val block = ps.optJSONObject(pid) ?: continue
                        val openObj = block.optJSONObject("open") ?: JSONObject()
                        val list = ArrayList<RemoteTab>()
                        for (u in openObj.keys()) {
                            val o = openObj.optJSONObject(u) ?: continue
                            val title = o.optString("title", u)
                            list.add(RemoteTab(title, u))
                            val m = open.getOrPut(pid) { HashMap() }
                            val at = o.optLong("at", 0)
                            if (at > (m[u]?.second ?: 0)) {
                                m[u] = Triple(title, at, o.optString("dev", id))
                            }
                        }
                        val closedObj = block.optJSONObject("closed") ?: JSONObject()
                        for (u in closedObj.keys()) {
                            val m = closed.getOrPut(pid) { HashMap() }
                            val at = closedObj.optLong(u, 0)
                            if (at > (m[u] ?: 0)) m[u] = at
                        }
                        byPersona[pid] = list
                    }
                    if (id != me) {
                        parsedNames[id] = d.optString("name", id)
                        parsedDevices[id] = byPersona
                    }
                }
                mergedOpen = open
                mergedClosed = closed
                devices = parsedDevices
                names = parsedNames

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
