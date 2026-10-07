package com.webforge.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// #286: the same cases as windows/defineterm.test.js and server/test_define.py.
class DefineTermTest {
    private val valid = listOf(
        "word" to "word",
        "  word  " to "word",
        "\"quoted,\"" to "quoted",
        "(bracketed)" to "bracketed",
        "“smart”" to "smart",
        "Hello!?" to "Hello",
        "end." to "end",
        "ice   cream" to "ice cream",
        "ice\n\tcream" to "ice cream",
        "don’t" to "don't",
        "‘tis’" to "tis",
        "rock'n'roll" to "rock'n'roll",
        "well-known" to "well-known",
        "-ing" to "ing",
        "naïve" to "naïve",
        "café" to "café",
        "日本語" to "日本語",
        "route 66" to "route 66",
        "a".repeat(64) to "a".repeat(64),
    )
    private val invalid = listOf(
        "",
        "   ",
        "...",
        "\"\" \"\"",
        "a".repeat(65),
        "two, words",
        "a/b",
        "foo@bar",
        "x=1",
        "The quick brown fox jumps over the lazy dog, then keeps on running far away",
        "tab\u0000bell",
    )

    @Test fun wordsAndShortPhrases() {
        for ((raw, want) in valid) assertEquals(raw, want, DefineTerm.clean(raw))
    }

    @Test fun everythingElseIsNotDefinable() {
        for (raw in invalid) assertNull(raw, DefineTerm.clean(raw))
        assertNull(DefineTerm.clean(null))
    }
}
