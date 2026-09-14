package com.webforge.browser

/**
 * The decisions the self-updater makes, with no Android in them so they can be
 * tested on the JVM (same reason [UserAgent] is split out).
 *
 * #149: the phone sat in an update loop for weeks — prompt, download, install,
 * still the old version, prompt again. The server was publishing a version
 * number next to an APK that didn't contain it, which is fixed at the build
 * now. But the *app* had no way to notice: it installed whatever it was given
 * and re-prompted forever, with nothing on screen to say why.
 *
 * So the client checks too. [verifyDownload] is the on-device twin of the
 * build-time gate in scripts/apkversion.js — if what actually arrived isn't
 * what was advertised, say so out loud instead of installing it and looping.
 */
object UpdateCheck {

    /** Strictly-newer semver comparison; missing or junk parts count as 0. */
    fun isNewer(remote: String, local: String): Boolean {
        val r = remote.split('.')
        val l = local.split('.')
        for (i in 0..2) {
            val rv = r.getOrNull(i)?.toIntOrNull() ?: 0
            val lv = l.getOrNull(i)?.toIntOrNull() ?: 0
            if (rv != lv) return rv > lv
        }
        return false
    }

    sealed class Verdict {
        /** Safe to hand to the package installer. */
        object Install : Verdict()

        /** Do not install — it would change nothing and we'd prompt again. */
        data class Refuse(val message: String) : Verdict()
    }

    /**
     * @param advertised what /version.txt promised
     * @param downloaded the versionName actually inside the downloaded APK,
     *                   or null when it couldn't be read
     * @param current    the running app's version
     */
    fun verifyDownload(advertised: String, downloaded: String?, current: String): Verdict {
        // Couldn't read it — a diagnostic failing is not a reason to block an
        // update that is probably fine. Proceed; the installer will complain if
        // the file is genuinely broken.
        if (downloaded == null) return Verdict.Install

        if (!isNewer(downloaded, current)) {
            // The loop, caught on the device. Installing this is a no-op and we
            // would be back here on the next launch.
            return Verdict.Refuse(
                "The server offered v$advertised but the file it sent is v$downloaded, " +
                    "which is not newer than the v$current you're running. " +
                    "Installing it would change nothing, so it was skipped. " +
                    "The release on dockerhost needs rebuilding."
            )
        }

        if (downloaded != advertised) {
            // Newer, but not what was promised. Worth installing — it does move
            // the app forward — but the mismatch is a release-process fault and
            // should not pass silently.
            return Verdict.Refuse(
                "The server offered v$advertised but sent v$downloaded. " +
                    "Not installing a file that isn't the one advertised — " +
                    "the release on dockerhost is inconsistent."
            )
        }

        return Verdict.Install
    }

    /** Human-readable reason for a DownloadManager COLUMN_REASON, for the toast. */
    fun downloadFailureText(reason: Int): String = when (reason) {
        // android.app.DownloadManager.ERROR_FILE_ALREADY_EXISTS
        1009 -> "a previous update file was left behind and could not be replaced"
        1007 -> "no storage space"
        1006 -> "not enough room for the download"
        1001 -> "a storage error"
        1004 -> "an HTTP error talking to dockerhost"
        1005 -> "too many redirects"
        1008 -> "the server doesn't support resuming"
        else -> "error code $reason"
    }
}
