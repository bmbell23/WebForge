package com.webforge.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageAtTest {
    @Test fun nothingUnderThePress() {
        assertNull(ImageAt.parse("null"))
        assertNull(ImageAt.parse(null))
        assertNull(ImageAt.parse("\"\""))
    }

    @Test fun plainImageAddress() {
        assertEquals("https://cdn.example.com/a.jpg", ImageAt.parse("\"https://cdn.example.com/a.jpg\""))
    }

    @Test fun escapesComeBackOut() {
        assertEquals(
            "https://x.com/a b/\"q\".jpg?t=1&é",
            ImageAt.parse("\"https:\\/\\/x.com\\/a b\\/\\\"q\\\".jpg?t=1&\\u00e9\"")
        )
    }

    @Test fun scriptCarriesThePoint() {
        val js = ImageAt.script(120f, 340.5f)
        assertTrue(js.contains("120.0 / d / s"))
        assertTrue(js.contains("340.5 / d / s"))
        assertTrue(js.contains("elementsFromPoint"))
    }
}
