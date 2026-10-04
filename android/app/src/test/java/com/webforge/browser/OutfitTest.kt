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
}
