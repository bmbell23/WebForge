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
import android.util.Log
import android.widget.Toast
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Self-update against the WebForge release endpoint on dockerhost
 * (see docker-compose.yml at the repo root — nginx serving ./releases).
 *
 * Flow: fetch /version.txt → if newer than BuildConfig.VERSION_NAME, offer the
 * update → DownloadManager pulls /webforge.apk → check the file really is what
 * was advertised → hand it to the system installer. Same signing key ⇒ installs
 * in-place as an upgrade.
 *
 * #149 — three faults here kept the phone in an update loop even after the
 * server was serving a correct APK, and all three were silent:
 *
 *  1. The destination file was never deleted. DownloadManager refuses to
 *     overwrite an existing explicit destination (ERROR_FILE_ALREADY_EXISTS),
 *     so the FIRST update worked and every one after it failed — which is
 *     exactly the reported behaviour: tap Update, nothing happens, prompt again.
 *  2. A failed download surfaced as "Update download failed" at best, with the
 *     actual reason discarded, so there was nothing to diagnose from.
 *  3. The receiver was registered AFTER enqueue, so a fast download on the
 *     tailnet could complete before anything was listening — leaving `busy`
 *     stuck true until the process died.
 *
 * Everything here now either succeeds or says why on screen. A silent no-op is
 * the one outcome this class must never have again.
 */
class UpdateManager(private val activity: Activity) {

    companion object {
        private const val TAG = "WebForgeUpdate"
        private const val BASE_URL = "http://100.69.184.113:8012"
        private const val VERSION_URL = "$BASE_URL/version.txt"
        private const val APK_URL = "$BASE_URL/webforge.apk"
        private const val APK_FILENAME = "webforge-update.apk"

        // Process-wide (#5): checkForUpdate() runs on every onResume, so these
        // guards keep one check/dialog/download at a time and stop a declined
        // version from re-prompting on every app switch (until next cold start).
        @Volatile private var busy = false
        @Volatile private var dismissedVersion: String? = null
        // #197: the version last handed to the system installer. The resume
        // that follows the hand-off must not offer it again.
        @Volatile private var handedOffVersion: String? = null
    }

    /** @param manual the Settings › Version tap: offers even a declined or handed-off version. */
    fun checkForUpdate(manual: Boolean = false) {
        if (busy) return
        busy = true
        Thread {
            val remote = fetchRemoteVersion()
            if (!UpdateCheck.shouldOffer(remote, BuildConfig.VERSION_NAME, dismissedVersion, handedOffVersion, manual)) {
                busy = false
                if (manual) activity.runOnUiThread {
                    Toast.makeText(
                        activity,
                        if (remote == null) "Couldn't reach dockerhost to check for updates"
                        else "WebForge v${BuildConfig.VERSION_NAME} is up to date",
                        Toast.LENGTH_SHORT
                    ).show()
                }
                return@Thread
            }
            val offer = remote ?: return@Thread // shouldOffer is false for null
            activity.runOnUiThread { offerUpdate(offer) }
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

    /** Where DownloadManager will put the APK — deterministic, so we can read it back. */
    private fun destination(): File? =
        activity.getExternalFilesDir(null)?.let { File(it, APK_FILENAME) }

    private fun download(remote: String) {
        val dest = destination()
        if (dest == null) {
            fail("No external storage available for the download")
            return
        }

        // #149 fault 1: DownloadManager will not overwrite an explicit
        // destination. Leftovers from the last update make every subsequent
        // download fail with ERROR_FILE_ALREADY_EXISTS, forever.
        if (dest.exists() && !dest.delete()) {
            fail("Could not remove the previous update file at ${dest.name}")
            return
        }

        val dm = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val request = DownloadManager.Request(Uri.parse(APK_URL))
            .setTitle("WebForge v$remote")
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setDestinationInExternalFilesDir(activity, null, APK_FILENAME)

        // #149 fault 3: register BEFORE enqueue. 900KB over the tailnet can land
        // faster than the next few statements run, and a missed broadcast wedges
        // `busy` until the process dies.
        var downloadId = -1L
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
                if (id == -1L || id != downloadId) return
                try {
                    context.unregisterReceiver(this)
                } catch (e: IllegalArgumentException) {
                    // already gone; harmless
                }
                busy = false
                onDownloadFinished(dm, downloadId, dest, remote)
            }
        }
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        if (Build.VERSION.SDK_INT >= 33) {
            activity.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            activity.registerReceiver(receiver, filter)
        }

        downloadId = dm.enqueue(request)
        Toast.makeText(activity, "Downloading WebForge v$remote…", Toast.LENGTH_SHORT).show()
    }

    private fun onDownloadFinished(dm: DownloadManager, id: Long, dest: File, remote: String) {
        // #149 fault 2: read the real status and reason instead of inferring
        // failure from a null URI and throwing the cause away.
        val query = DownloadManager.Query().setFilterById(id)
        var status = -1
        var reason = 0
        dm.query(query)?.use { c ->
            if (c.moveToFirst()) {
                status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
            }
        }

        if (status != DownloadManager.STATUS_SUCCESSFUL) {
            fail("Update download failed — ${UpdateCheck.downloadFailureText(reason)}")
            return
        }

        // What did we actually receive? The build-time gate in
        // scripts/apkversion.js asks the same question of the same artifact;
        // this is the half that protects the phone if a bad release escapes.
        val downloadedVersion = readApkVersion(dest)
        Log.i(TAG, "downloaded v$downloadedVersion (advertised v$remote, running v${BuildConfig.VERSION_NAME})")

        when (val verdict = UpdateCheck.verifyDownload(remote, downloadedVersion, BuildConfig.VERSION_NAME)) {
            is UpdateCheck.Verdict.Refuse -> {
                // Loud and persistent: this is a server-side fault the user is
                // the only one who can see, and a toast would be missed.
                dismissedVersion = remote // don't re-offer the same bad release this session
                AlertDialog.Builder(activity)
                    .setTitle("Update skipped")
                    .setMessage(verdict.message)
                    .setPositiveButton("OK", null)
                    .show()
            }
            is UpdateCheck.Verdict.Install -> install(dm, id, remote)
        }
    }

    /** versionName inside a downloaded APK, or null if it can't be read. */
    private fun readApkVersion(apk: File): String? = try {
        activity.packageManager.getPackageArchiveInfo(apk.absolutePath, 0)?.versionName
    } catch (e: Exception) {
        Log.w(TAG, "could not read version from ${apk.absolutePath}", e)
        null
    }

    private fun install(dm: DownloadManager, id: Long, remote: String) {
        val apkUri = dm.getUriForDownloadedFile(id)
        if (apkUri == null) {
            fail("Update downloaded but could not be opened for install")
            return
        }
        handedOffVersion = remote // #197: before startActivity, which pauses and resumes us
        activity.startActivity(
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(apkUri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        )
    }

    private fun fail(message: String) {
        busy = false
        Log.w(TAG, message)
        if (activity.isFinishing) return
        activity.runOnUiThread {
            Toast.makeText(activity, message, Toast.LENGTH_LONG).show()
        }
    }
}
