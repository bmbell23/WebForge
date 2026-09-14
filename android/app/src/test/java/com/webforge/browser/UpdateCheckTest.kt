package com.webforge.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #149. The case that matters is [refuses_an_apk_that_is_not_actually_newer]:
 * that is the live loop the phone sat in, and the assertion that it is now
 * refused rather than installed-and-forgotten.
 */
class UpdateCheckTest {

    // --- the loop ------------------------------------------------------------

    @Test
    fun refuses_an_apk_that_is_not_actually_newer() {
        // Exactly what the phone was being handed: told 0.1.156, sent 0.1.151,
        // running 0.1.151. Installing changes nothing and we re-prompt forever.
        val v = UpdateCheck.verifyDownload("0.1.156", "0.1.151", "0.1.151")
        assertTrue(v is UpdateCheck.Verdict.Refuse)
        val message = (v as UpdateCheck.Verdict.Refuse).message
        assertTrue("must name what was promised", message.contains("0.1.156"))
        assertTrue("must name what arrived", message.contains("0.1.151"))
    }

    @Test
    fun refuses_an_apk_that_is_newer_but_not_the_one_advertised() {
        val v = UpdateCheck.verifyDownload("0.1.156", "0.1.153", "0.1.151")
        assertTrue(v is UpdateCheck.Verdict.Refuse)
    }

    @Test
    fun installs_when_the_download_is_what_was_promised() {
        assertEquals(
            UpdateCheck.Verdict.Install,
            UpdateCheck.verifyDownload("0.1.156", "0.1.156", "0.1.151")
        )
    }

    @Test
    fun an_unreadable_apk_still_installs_rather_than_blocking_on_a_diagnostic() {
        // The version check is a safety net, not a gate. If it can't run, the
        // update is probably fine and the installer will reject a broken file.
        assertEquals(
            UpdateCheck.Verdict.Install,
            UpdateCheck.verifyDownload("0.1.156", null, "0.1.151")
        )
    }

    @Test
    fun refuses_a_downgrade() {
        val v = UpdateCheck.verifyDownload("0.1.156", "0.1.150", "0.1.151")
        assertTrue(v is UpdateCheck.Verdict.Refuse)
    }

    // --- version comparison --------------------------------------------------

    @Test
    fun versions_compare_numerically_not_as_strings() {
        assertTrue(UpdateCheck.isNewer("0.1.10", "0.1.9"))
        assertTrue(!UpdateCheck.isNewer("0.1.9", "0.1.10"))
        assertTrue(UpdateCheck.isNewer("0.2.0", "0.1.99"))
        assertTrue(!UpdateCheck.isNewer("0.1.156", "0.1.156"))
    }

    @Test
    fun junk_version_parts_count_as_zero_and_do_not_throw() {
        assertTrue(!UpdateCheck.isNewer("", "0.1.1"))
        assertTrue(UpdateCheck.isNewer("0.1.1", ""))
        assertTrue(!UpdateCheck.isNewer("a.b.c", "0.0.1"))
    }

    // --- failure reporting ---------------------------------------------------

    @Test
    fun the_file_already_exists_failure_is_named_in_plain_words() {
        // 1009 == DownloadManager.ERROR_FILE_ALREADY_EXISTS, the fault that made
        // every update after the first one fail silently.
        val text = UpdateCheck.downloadFailureText(1009)
        assertTrue(text.contains("previous update file"))
    }

    @Test
    fun an_unknown_failure_still_reports_its_code() {
        assertTrue(UpdateCheck.downloadFailureText(9999).contains("9999"))
    }
}
