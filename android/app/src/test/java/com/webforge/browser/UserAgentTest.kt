package com.webforge.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #134: the phone must stop identifying as an embedded WebView, for the same
 * reason the desktop stops identifying as Electron. Runs on the JVM (no device)
 * because [UserAgent] is free of Android APIs — same pattern as [VaultCryptoTest].
 *
 * The Windows half of this lives in `windows/useragent.test.js`; the two assert
 * the same properties against their own engine's string.
 */
class UserAgentTest {

    // A real Android System WebView UA (Chrome 132 era).
    private val real =
        "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP1A.240505.004; wv) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/132.0.0.0 " +
            "Mobile Safari/537.36"

    @Test
    fun `both WebView giveaway tokens are gone`() {
        val ua = UserAgent.clean(real)
        assertFalse("wv token survived: $ua", Regex("""\bwv\b""").containsMatchIn(ua))
        assertFalse("Version token survived: $ua", ua.contains("Version/"))
    }

    @Test
    fun `the result is exactly what mobile Chrome would send`() {
        assertEquals(
            "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP1A.240505.004) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 " +
                "Mobile Safari/537.36",
            UserAgent.clean(real)
        )
    }

    @Test
    fun `the Chrome version token is untouched - sniffers gate on it`() {
        assertTrue(UserAgent.clean(real).contains("Chrome/132.0.0.0"))
    }

    @Test
    fun `device and platform details survive`() {
        val ua = UserAgent.clean(real)
        for (part in listOf("Linux; Android 14", "Pixel 7", "AppleWebKit/537.36", "Mobile Safari/537.36")) {
            assertTrue("lost $part", ua.contains(part))
        }
    }

    @Test
    fun `no ragged spacing is left behind`() {
        val ua = UserAgent.clean(real)
        assertFalse("double space betrays the edit", ua.contains("  "))
        assertFalse("dangling separator", ua.contains("; )"))
        assertFalse("dangling separator", ua.contains(" )"))
    }

    @Test
    fun `a UA with neither token is returned unchanged`() {
        val plain =
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/132.0.0.0 Mobile Safari/537.36"
        assertEquals(plain, UserAgent.clean(plain))
    }

    @Test
    fun `running it twice changes nothing`() {
        val once = UserAgent.clean(real)
        assertEquals(once, UserAgent.clean(once))
    }

    @Test
    fun `a UA that only says wv is still handled`() {
        assertEquals(
            "Mozilla/5.0 (Linux; Android 14) Chrome/132.0.0.0",
            UserAgent.clean("Mozilla/5.0 (Linux; Android 14; wv) Chrome/132.0.0.0")
        )
    }

    @Test
    fun `junk in does not throw`() {
        assertEquals("", UserAgent.clean(null))
        assertEquals("", UserAgent.clean(""))
    }
}
