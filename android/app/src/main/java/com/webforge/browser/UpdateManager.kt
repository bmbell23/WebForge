package com.webforge.browser

import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.widget.Toast
import java.net.HttpURLConnection
import java.net.URL

/**
 * Self-update against the WebForge release endpoint on dockerhost
 * (see docker-compose.yml at the repo root — nginx serving ./releases).
 *
 * Flow: fetch /version.txt → if newer than BuildConfig.VERSION_NAME, offer the
 * update → DownloadManager pulls /webforge.apk → hand the finished download to
 * the system installer. Same signing key ⇒ installs in-place as an upgrade.
 */
class UpdateManager(private val activity: Activity) {

    companion object {
        private const val BASE_URL = "http://100.69.184.113:8012"
        private const val VERSION_URL = "$BASE_URL/version.txt"
        private const val APK_URL = "$BASE_URL/webforge.apk"

        // Process-wide (#5): checkForUpdate() runs on every onResume, so these
        // guards keep one check/dialog/download at a time and stop a declined
        // version from re-prompting on every app switch (until next cold start).
        @Volatile private var busy = false
        @Volatile private var dismissedVersion: String? = null
    }

    fun checkForUpdate() {
        if (busy) return
        busy = true
        Thread {
            val remote = fetchRemoteVersion()
            if (remote == null || remote == dismissedVersion ||
                !isNewer(remote, BuildConfig.VERSION_NAME)
            ) {
                busy = false
                return@Thread
            }
            activity.runOnUiThread { offerUpdate(remote) }
        }.start()
    }

    private fun fetchRemoteVersion(): String? = try {
        val conn = URL(VERSION_URL).openConnection() as HttpURLConnection
        conn.connectTimeout = 5000
        conn.readTimeout = 5000
        try {
            conn.inputStream.bufferedReader().readText().trim()
                .takeIf { Regex("""\d+\.\d+\.\d+""").matches(it) }
        } finally {
            conn.disconnect()
        }
    } catch (e: Exception) {
        null // offline / off the tailnet / server down — silently skip
    }

    private fun isNewer(remote: String, local: String): Boolean {
        val r = remote.split('.').map { it.toIntOrNull() ?: 0 }
        val l = local.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0..2) {
            val rv = r.getOrElse(i) { 0 }
            val lv = l.getOrElse(i) { 0 }
            if (rv != lv) return rv > lv
        }
        return false
    }

    private fun offerUpdate(remote: String) {
        if (activity.isFinishing) {
            busy = false
            return
        }
        var accepted = false
        AlertDialog.Builder(activity)
            .setTitle("Update available")
            .setMessage("WebForge v$remote is available (you have v${BuildConfig.VERSION_NAME}). Install now?")
            .setPositiveButton("Update") { _, _ ->
                accepted = true
                download(remote)
            }
            .setNegativeButton("Later") { _, _ -> dismissedVersion = remote }
            .setOnDismissListener {
                // Covers Later, back-button, and touch-outside; on Update the
                // download keeps `busy` held until it finishes or fails.
                if (!accepted) busy = false
            }
            .show()
    }

    private fun download(remote: String) {
        val dm = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val request = DownloadManager.Request(Uri.parse(APK_URL))
            .setTitle("WebForge v$remote")
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setDestinationInExternalFilesDir(activity, null, "webforge-update.apk")
        val downloadId = dm.enqueue(request)
        Toast.makeText(activity, "Downloading WebForge v$remote…", Toast.LENGTH_SHORT).show()

        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
                if (id != downloadId) return
                context.unregisterReceiver(this)
                busy = false
                val apkUri = dm.getUriForDownloadedFile(downloadId)
                if (apkUri == null) {
                    Toast.makeText(context, "Update download failed", Toast.LENGTH_LONG).show()
                    return
                }
                context.startActivity(
                    Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(apkUri, "application/vnd.android.package-archive")
                        addFlags(
                            Intent.FLAG_ACTIVITY_NEW_TASK or
                                Intent.FLAG_GRANT_READ_URI_PERMISSION
                        )
                    }
                )
            }
        }
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        if (Build.VERSION.SDK_INT >= 33) {
            activity.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            activity.registerReceiver(receiver, filter)
        }
    }
}
