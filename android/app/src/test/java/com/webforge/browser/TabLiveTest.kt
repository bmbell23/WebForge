package com.webforge.browser

import org.junit.Assert.assertEquals
import org.junit.Test

/** #155: which tabs lose their live page. */
class TabLiveTest {
    @Test
    fun keeps_the_active_tab_and_the_most_recent_others() {
        // six loaded tabs, 0 oldest; tab 1 active
        val at = listOf(10L, 20L, 30L, 40L, 50L, 60L)
        val loaded = List(6) { true }
        // live: 1 (active) + 5, 4, 3 (three most recent others); unload 0 and 2, oldest first
        assertEquals(listOf(0, 2), TabLive.toUnload(at, loaded, 1, 4))
    }

    @Test
    fun unloaded_tabs_do_not_count() {
        val at = listOf(10L, 20L, 30L, 40L, 50L, 60L)
        val loaded = listOf(true, false, false, true, false, true)
        assertEquals(emptyList<Int>(), TabLive.toUnload(at, loaded, 5, 4))
    }

    @Test
    fun the_active_tab_is_never_unloaded_even_if_oldest() {
        val at = listOf(1L, 50L, 60L, 70L, 80L)
        assertEquals(listOf(1), TabLive.toUnload(at, List(5) { true }, 0, 4))
    }

    @Test
    fun few_tabs_means_nothing_to_do() {
        assertEquals(emptyList<Int>(), TabLive.toUnload(listOf(1L, 2L), listOf(true, true), 0, 4))
        assertEquals(emptyList<Int>(), TabLive.toUnload(emptyList(), emptyList(), -1, 4))
    }
}
