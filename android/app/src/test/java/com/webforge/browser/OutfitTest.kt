package com.webforge.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** #181: reads the same fixtures as `windows/museforge.test.js`, so both apps open the same Studio address. */
class OutfitTest {
    private fun shared(name: String): File {
        for (p in listOf("../../shared/$name", "../shared/$name")) File(p).let { if (it.exists()) return it }
        throw AssertionError("shared/$name not found from ${File(".").absolutePath}")
    }

    @Test
    fun matches_every_shared_fixture() {
        var rows = 0
        for (line in shared("outfit-fixtures.tsv").readLines()) {
            if (line.isBlank() || line.startsWith("#")) continue
            val p = line.split("\t")
            assertEquals("fixture: $line", p[3].ifEmpty { null }, Outfit.url(p[0], p[1], p[2]))
            rows++
        }
        assertTrue("only $rows fixtures read", rows >= 7)
    }

    // #195: the same rows windows/museforge.test.js reads.
    @Test
    fun create_result_matches_every_shared_fixture() {
        var rows = 0
        for (line in shared("outfit-create-fixtures.tsv").readLines()) {
            if (line.isBlank() || line.startsWith("#")) continue
            val p = line.split("\t")
            assertEquals("fixture: $line", p[2], Outfit.createResult(p[0].toInt(), p[1].ifEmpty { null }))
            rows++
        }
        assertTrue("only $rows fixtures read", rows >= 10)
    }

    @Test
    fun create_form_keeps_src_query_and_encodes_text() {
        assertEquals(
            "src=https%3A%2F%2Fx.com%2Fa.jpg%3Fw%3D1%26h%3D2&name=jacket&text=a+%26+b",
            Outfit.createForm("https://x.com/a.jpg?w=1&h=2", " jacket ", "a & b "),
        )
        assertEquals("src=http%3A%2F%2Fx.com%2Fa.jpg&name=&text=", Outfit.createForm("http://x.com/a.jpg", null, null))
        assertEquals(null, Outfit.createForm("data:image/png;base64,AAAA", "n", "t"))
    }

    // #191: the same rows windows/museforge.test.js reads.
    @Test
    fun done_page_matches_every_shared_fixture() {
        var rows = 0
        for (line in shared("outfit-done-fixtures.tsv").readLines()) {
            if (line.isBlank() || line.startsWith("#")) continue
            val p = line.split("\t")
            assertEquals("fixture: $line", p[1] == "1", Outfit.isDone(p[0]))
            rows++
        }
        assertTrue("only $rows fixtures read", rows >= 8)
    }
}
