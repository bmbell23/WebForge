package com.webforge.browser

import android.content.Context
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

/**
 * #60: debugging the phone build is blind without adb, and the user is often
 * away from a machine. Capture any uncaught exception to a file so the next
 * launch can show it in Settings.
 */
object CrashLog {
    private fun file(c: Context) = File(c.filesDir, "last-crash.txt")

    fun install(c: Context) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                val sw = StringWriter()
                error.printStackTrace(PrintWriter(sw))
                file(c).writeText(
                    "WebForge ${BuildConfig.VERSION_NAME}\n" +
                        "thread: ${thread.name}\n\n$sw"
                )
            } catch (ignored: Throwable) {
                // never let crash reporting cause a second crash
            }
            previous?.uncaughtException(thread, error)
        }
    }

    fun last(c: Context): String? = try {
        file(c).takeIf { it.exists() }?.readText()
    } catch (e: Exception) {
        null
    }

    fun clear(c: Context) {
        try {
            file(c).delete()
        } catch (ignored: Exception) {
        }
    }
}
