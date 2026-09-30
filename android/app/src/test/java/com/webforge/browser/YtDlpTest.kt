package com.webforge.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * #156. Reads the same site list and fixtures as `windows/ytdlp.test.js`, so
 * the phone and the PC send identical bodies for the same page and choice.
 */
class YtDlpTest {
    private fun shared(name: String): File {
        for (p in listOf("../../shared/$name", "../shared/$name")) File(p).let { if (it.exists()) return it }
        throw AssertionError("shared/$name not found from ${File(".").absolutePath}")
    }

    private val sites = YtDlp.parse(shared("ytdlp-sites.json").readText())

    @Test
    fun matches_every_shared_fixture() {
        var rows = 0
        for (line in shared("ytdlp-fixtures.tsv").readLines()) {
            if (line.isBlank() || line.startsWith("#")) continue
            val p = line.split("\t")
            val b = YtDlp.body(sites, p[0], p[1], p[2] == "1")
            assertEquals("fixture: $line", listOf(p[1], p[3] == "1", p[4] == "1", p[5] == "1"),
                listOf(b.format, b.adult, b.short, b.kids))
            rows++
        }
        assertTrue("only $rows fixtures read", rows >= 15)
    }

    @Test
    fun reads_the_shared_site_list() {
        assertEquals("http://100.69.184.113:8001/api/download/ytdlp", sites.endpoint)
        assertTrue(sites.adult.contains("youporn.com"))
        assertTrue(sites.short.contains("redgifs.com"))
    }

    @Test
    fun picker_overrides() {
        assertTrue(YtDlp.body(sites, "https://www.youtube.com/watch?v=a", "video", false, adult = true).adult)
        assertFalse(YtDlp.body(sites, "https://www.youporn.com/x", "video", false, adult = false).adult)
        assertFalse(YtDlp.body(sites, "https://www.youporn.com/x", "video", true, adult = true).adult)
        assertEquals("video", YtDlp.body(sites, "https://youtube.com/x", "nonsense", false).format)
    }

    @Test
    fun only_web_pages_can_be_sent() {
        assertTrue(YtDlp.downloadable("https://www.youtube.com/watch?v=a"))
        assertFalse(YtDlp.downloadable("file:///android_asset/newtab.html"))
        assertFalse(YtDlp.downloadable("about:blank"))
        assertFalse(YtDlp.downloadable(""))
    }

    @Test
    fun body_json_is_what_the_dashboard_expects() {
        val b = YtDlp.body(sites, "https://youtube.com/watch?v=\"a\"", "audio", true)
        assertEquals("""{"url":"https://youtube.com/watch?v=\"a\"","format":"audio","adult":false,"short":false,"kids":true}""", b.toJson())
    }
}
