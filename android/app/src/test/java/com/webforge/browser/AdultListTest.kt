package com.webforge.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** #203. Mirrors windows/adultlist.test.js; both read shared/adult-entry-fixtures.tsv. */
class AdultListTest {
    private fun shared(name: String): File {
        for (p in listOf("../../shared/$name", "../shared/$name")) File(p).let { if (it.exists()) return it }
        throw AssertionError("shared/$name not found from ${File(".").absolutePath}")
    }

    private val base = YtDlp.Sites(
        "e", listOf("a.com", "b.com"), listOf("s.com"), listOf("porn"), listOf("*:8005"),
    )

    @Test
    fun normalize_matches_every_shared_fixture() {
        var rows = 0
        for (line in shared("adult-entry-fixtures.tsv").readText().split("\n")) {
            if (line.startsWith("#") || !line.contains('\t')) continue
            val tab = line.lastIndexOf('\t')
            val want = line.substring(tab + 1)
            assertEquals("fixture: $line", if (want == "-") null else want, AdultList.normalize(line.substring(0, tab)))
            rows++
        }
        assertTrue("only $rows fixture rows read", rows >= 20)
    }

    @Test
    fun normalize_of_null_is_null() {
        assertEquals(null, AdultList.normalize(null))
    }

    @Test
    fun clean_normalizes_dedupes_and_removal_wins() {
        val u = AdultList.clean(listOf("Foo.com", "https://foo.com/x", "junk", "bar.com"), listOf("bar.com"))
        assertEquals(listOf("foo.com"), u.added)
        assertEquals(listOf("bar.com"), u.removed)
        val empty = AdultList.clean(emptyList(), emptyList())
        assertEquals(emptyList<String>(), empty.added)
        assertEquals(emptyList<String>(), empty.removed)
    }

    @Test
    fun effective_merges_with_the_built_in_list() {
        val eff = AdultList.effective(base, listOf("c.com", "10.0.0.1:81"), listOf("b.com", "*:8005"))
        assertEquals(listOf("a.com", "c.com"), eff.adult)
        assertEquals(listOf("10.0.0.1:81"), eff.adultOrigins)
        assertEquals(listOf("porn"), eff.adultWords)
        assertEquals(listOf("s.com"), eff.short)
        assertEquals("e", eff.endpoint)
        assertEquals(listOf("a.com", "b.com"), AdultList.effective(base, emptyList(), emptyList()).adult)
        assertEquals(listOf("a.com", "b.com"), base.adult)
    }

    @Test
    fun the_matcher_uses_it() {
        val url = "https://cdn.wholesome-example.org/x"
        assertTrue(!YtDlp.isAdult(base, url))
        assertTrue(YtDlp.isAdult(AdultList.effective(base, listOf("wholesome-example.org"), emptyList()), url))
        val off = AdultList.effective(base, emptyList(), listOf("*:8005"))
        assertTrue(!YtDlp.isAdult(off, "http://100.69.184.113:8005/"))
        assertTrue(YtDlp.isAdult(base, "http://100.69.184.113:8005/"))
    }
}
