package com.webforge.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * #152. The load-bearing test is [matches_every_shared_fixture]: it reads the
 * same file `windows/taburl.test.js` reads, so the two platforms cannot drift.
 * Android duplicated tabs without limit precisely because it had no
 * canonicalisation at all while Windows did.
 */
class TabUrlTest {

    /** Unit tests run with the module dir (android/app) as working directory. */
    private fun fixtureFile(): File {
        for (path in listOf("../../shared/taburl-fixtures.tsv", "../shared/taburl-fixtures.tsv")) {
            val f = File(path)
            if (f.exists()) return f
        }
        throw AssertionError("shared/taburl-fixtures.tsv not found from ${File(".").absolutePath}")
    }

    @Test
    fun matches_every_shared_fixture() {
        var checked = 0
        for (line in fixtureFile().readLines()) {
            if (line.isBlank() || line.startsWith("#")) continue
            val parts = line.split("\t")
            if (parts.size < 2) continue
            val input = parts[0]
            val expected = if (parts[1] == "''") "" else parts[1]
            assertEquals("fixture: '$input'", expected, TabUrl.canonical(input))
            checked++
        }
        // A missing or emptied fixture file would otherwise make this pass silently.
        assertTrue("only $checked fixtures read — is the file intact?", checked >= 20)
    }

    // --- the incident, stated directly -------------------------------------

    @Test
    fun the_variants_that_produced_16_schwab_tabs_collapse_to_one() {
        // `it.url == url` in the adoption loop treated every one of these as a
        // new page, so each sync cycle adopted another copy.
        val key = TabUrl.canonical("https://client.schwab.com/app/trade")
        for (variant in listOf(
            "https://client.schwab.com/app/trade/",
            "https://client.schwab.com/app/trade#summary",
            "http://client.schwab.com/app/trade",
            "https://www.client.schwab.com/app/trade",
        )) {
            assertEquals("variant should collapse: $variant", key, TabUrl.canonical(variant))
        }
    }

    @Test
    fun a_changed_query_string_is_still_a_different_page() {
        // Honest limit: canonicalisation alone does NOT fix an auth bounce that
        // rotates a token. The adoption cap and the closedAt tombstone do the
        // rest — see #152.
        assertNotEquals(
            TabUrl.canonical("https://client.schwab.com/login?session=aaa"),
            TabUrl.canonical("https://client.schwab.com/login?session=bbb")
        )
    }

    // --- the rules -----------------------------------------------------------

    @Test
    fun hash_routes_are_distinct_pages_but_anchors_are_not() {
        assertNotEquals(
            TabUrl.canonical("https://app.test/#/dashboard"),
            TabUrl.canonical("https://app.test/#/settings")
        )
        assertEquals(
            TabUrl.canonical("https://docs.test/guide#install"),
            TabUrl.canonical("https://docs.test/guide#intro")
        )
    }

    @Test
    fun non_http_schemes_are_left_alone_so_internal_pages_never_merge() {
        assertEquals("about:blank", TabUrl.canonical("about:blank"))
        assertNotEquals(
            TabUrl.canonical("file:///data/ui/newtab.html"),
            TabUrl.canonical("file:///data/ui/settings.html")
        )
    }

    @Test
    fun blank_and_junk_never_match_anything() {
        assertEquals("", TabUrl.canonical(null))
        assertEquals("", TabUrl.canonical("   "))
        assertTrue(!TabUrl.sameTab(null, null))
        assertTrue(!TabUrl.sameTab("", ""))
        // Unparseable input compares literally rather than being guessed at.
        assertTrue(TabUrl.sameTab("not a url", "not a url"))
        assertTrue(!TabUrl.sameTab("not a url", "also not a url"))
    }

    @Test
    fun indexOf_finds_the_first_matching_tab_and_minus_one_otherwise() {
        val urls = listOf("https://a.test/", "https://b.test/x", "https://c.test")
        assertEquals(1, TabUrl.indexOf(urls, "http://www.b.test/x/"))
        assertEquals(-1, TabUrl.indexOf(urls, "https://d.test"))
        assertEquals(-1, TabUrl.indexOf(urls, null))
    }
}
