package com.webforge.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** #298. Mirrors `windows/tabsync.test.js`: the two platforms must agree. */
class TabSyncTest {
    private val now = 1_800_000_000_000L
    private val h = 3600L * 1000
    private fun dev(name: String, at: Long, vararg open: Pair<String, Long>) =
        DeviceFacts(name, at, open.map { OtherTab("t " + it.first, it.first, it.second) })

    @Test
    fun silent_devices_are_stale_but_this_one_never_is() {
        val ats = mapOf("me" to now - 10 * TabSync.STALE_MS, "old" to now - 121 * h, "ph" to now - h)
        assertEquals(setOf("old"), TabSync.staleDeviceIds(ats, now, "me"))
    }

    @Test
    fun exactly_three_days_is_still_live() {
        assertTrue(TabSync.staleDeviceIds(mapOf("ph" to now - TabSync.STALE_MS), now, "me").isEmpty())
    }

    @Test
    fun close_facts_outlive_their_device_until_the_tombstone_ttl() {
        val kept = TabSync.liveClosed(
            mapOf("https://c.com/" to now - 4 * 24 * h, "https://z.com/" to now - 40 * 24 * h), now
        )
        assertEquals(setOf("https://c.com/"), kept.keys)
    }

    @Test
    fun lists_other_devices_newest_first() {
        val d = mapOf(
            "me" to dev("Phone", now, "https://mine.com/" to 5),
            "w" to dev("Windows", now, "https://a.com/" to 10, "https://b.com/" to 30),
            "t" to dev("Tablet", now, "https://c.com/" to 50),
        )
        val out = TabSync.otherDeviceTabs(d, "me", emptyList(), { false })
        assertEquals(listOf("Tablet", "Windows"), out.map { it.device })
        assertEquals(listOf("https://b.com/", "https://a.com/"), out[1].tabs.map { it.url })
    }

    @Test
    fun excludes_open_here_canonically_and_adult() {
        val d = mapOf("w" to dev("Windows", now, "https://a.com/x" to 1, "https://b.com/" to 2, "https://adult.test/" to 3))
        val out = TabSync.otherDeviceTabs(d, "me", listOf("https://a.com/x/"), { it.contains("adult") })
        assertEquals(listOf("https://b.com/"), out[0].tabs.map { it.url })
    }

    @Test
    fun silent_devices_are_not_listed_and_empty_groups_vanish() {
        val d = mapOf("old" to dev("Windows", now - 121 * h, "https://a.com/" to 1), "ph" to dev("Phone", now, "https://b.com/" to 2))
        assertEquals(listOf("Phone"), TabSync.otherDeviceTabs(d, "me", emptyList(), { false }, now).map { it.device })
    }
}
