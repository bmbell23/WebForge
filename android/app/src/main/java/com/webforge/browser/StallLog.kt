package com.webforge.browser

import android.view.Choreographer

/**
 * #155: "it's laggy" as numbers. While the app is in front, times every frame
 * on the UI thread and keeps the last few gaps over [THRESHOLD_MS], shown in
 * Settings. It can't see stalls inside the page's renderer process, only ours.
 */
object StallLog {
    private const val THRESHOLD_MS = 100L
    private const val KEEP = 20
    private val stalls = ArrayDeque<Pair<Long, Long>>() // (wall clock ms, stall ms)
    private var last = 0L
    private var running = false

    private val cb = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!running) return
            val now = frameTimeNanos / 1_000_000
            if (last != 0L && now - last >= THRESHOLD_MS) {
                stalls.addLast(System.currentTimeMillis() to (now - last))
                while (stalls.size > KEEP) stalls.removeFirst()
            }
            last = now
            Choreographer.getInstance().postFrameCallback(this)
        }
    }

    fun start() {
        if (running) return
        running = true
        last = 0L // the gap while we were away isn't a stall
        Choreographer.getInstance().postFrameCallback(cb)
    }

    fun stop() {
        running = false
        Choreographer.getInstance().removeFrameCallback(cb)
    }

    /** Newest first: "10:42:07  340 ms". */
    fun lines(): List<String> {
        val fmt = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
        return stalls.reversed().map { (at, ms) -> "${fmt.format(java.util.Date(at))}  $ms ms" }
    }
}
