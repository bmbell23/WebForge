package com.webforge.browser

/**
 * #155: how many tabs keep a live page. Android WebViews share one renderer
 * process, so every loaded background tab (a bank's keep-alive timers, a
 * feed's polling) competes with the page you're typing into. The phone was
 * keeping every tab you'd ever opened live and running.
 *
 * Pure so it's unit-tested (TabLiveTest); MainActivity does the unloading.
 */
object TabLive {
    /** The active tab plus this many recent ones stay loaded. */
    const val MAX_LIVE = 4

    /**
     * Indices of loaded tabs to unload: everything loaded except the active tab
     * and the [max] - 1 most recently active others. Oldest first.
     */
    fun toUnload(lastActive: List<Long>, loaded: List<Boolean>, activeIndex: Int, max: Int = MAX_LIVE): List<Int> {
        val others = lastActive.indices
            .filter { it != activeIndex && loaded.getOrElse(it) { false } }
            .sortedByDescending { lastActive[it] }
        return others.drop((max - 1).coerceAtLeast(0)).sortedBy { lastActive[it] }
    }
}
