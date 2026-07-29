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
 * Each device publishes its own per-Persona tab list under a stable device id;
 * every device reads the others'. Deliberately **non-destructive**: a tab
 * disappearing from a remote list never closes anything locally. Full mirroring
 * (closes propagating) waits for the undo / recently-closed net, because a
 * mis-tap on one device would otherwise destroy a tab everywhere.
 */
object TabSync {
    private const val URL_STR = "http://100.69.184.113:8013/store/tabs"
    private var devices: Map<String, Map<String, List<RemoteTab>>> = emptyMap()
    private var names: Map<String, String> = emptyMap()

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
    fun sync(c: Context, local: Map<String, List<RemoteTab>>, done: () -> Unit = {}) {
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

                // Read everyone else's lists.
                val parsedDevices = HashMap<String, Map<String, List<RemoteTab>>>()
                val parsedNames = HashMap<String, String>()
                for (id in devs.keys()) {
                    if (id == me) continue
                    val d = devs.optJSONObject(id) ?: continue
                    parsedNames[id] = d.optString("name", id)
                    val byPersona = HashMap<String, List<RemoteTab>>()
                    val ps = d.optJSONObject("personas") ?: JSONObject()
                    for (pid in ps.keys()) {
                        val arr = ps.optJSONArray(pid) ?: continue
                        val list = ArrayList<RemoteTab>(arr.length())
                        for (i in 0 until arr.length()) {
                            val o = arr.optJSONObject(i) ?: continue
                            val u = o.optString("url")
                            if (u.isNotEmpty()) list.add(RemoteTab(o.optString("title", u), u))
                        }
                        byPersona[pid] = list
                    }
                    parsedDevices[id] = byPersona
                }
                devices = parsedDevices
                names = parsedNames

                // Publish ours alongside, leaving other devices' entries intact.
                val mine = JSONObject()
                for ((pid, list) in local) {
                    val arr = JSONArray()
                    for (t in list) arr.put(JSONObject().put("title", t.title).put("url", t.url))
                    mine.put(pid, arr)
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
