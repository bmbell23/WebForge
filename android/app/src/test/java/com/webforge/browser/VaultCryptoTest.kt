package com.webforge.browser

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #55 acceptance 5: the Android vault and `windows/vault.js` must be able to
 * open each other's blobs, or the credential sync in the 3/3 ticket cannot work.
 *
 * Runs on the JVM (no device needed) because [VaultCrypto] is free of Android
 * APIs. Drive the other half with:
 *     node scripts/vault-interop.js seal <file>   # regenerate WINDOWS_* below
 *     node scripts/vault-interop.js open build/vault-interop/kotlin-blob.json
 */
class VaultCryptoTest {
    private val password = "test-master-password"

    // Golden vector produced by the REAL windows/vault.js via
    // `node scripts/vault-interop.js seal`. It seals JSON.stringify(VERIFIER),
    // so the plaintext is 22 bytes: the 20-char verifier plus two quotes.
    private val windowsIv = "lYqFBbzTu3XIrdF9"
    private val windowsTag = "aEpfrJhRxLbZou+W3rDWmw=="
    private val windowsData = "hzNJEQxRk4q7cFj2X6qaHEjmGBXaVw=="
    private val windowsSalt = "cZWOJAulM9XLQBzxXMSaLQ=="

    /** Windows -> Android. */
    @Test
    fun opensABlobSealedByWindowsVaultJs() {
        val key = VaultCrypto.derive(password, VaultCrypto.decode(windowsSalt))
        val blob = VaultCrypto.Blob(iv = windowsIv, tag = windowsTag, data = windowsData)
        assertEquals(
            "Kotlin must decrypt what windows/vault.js sealed",
            VaultCrypto.VERIFIER_JSON,
            VaultCrypto.open(key, blob),
        )
    }

    /**
     * Android -> Windows. Kotlin cannot call vault.js, so this emits the blob and
     * `vault-interop.js open` asserts the desktop side accepts it. The build step
     * that runs both is what closes the loop.
     */
    @Test
    fun emitsABlobForWindowsVaultJsToOpen() {
        val salt = VaultCrypto.randomBytes(VaultCrypto.SALT_LEN)
        val key = VaultCrypto.derive(password, salt)
        val blob = VaultCrypto.seal(key, VaultCrypto.VERIFIER_JSON)
        // Round-trips in Kotlin at minimum; the node script proves the rest.
        assertEquals(VaultCrypto.VERIFIER_JSON, VaultCrypto.open(key, blob))

        val out = File("build/vault-interop").apply { mkdirs() }.resolve("kotlin-blob.json")
        out.writeText(
            """{"salt":"${VaultCrypto.encode(salt)}","iv":"${blob.iv}",""" +
                """"tag":"${blob.tag}","data":"${blob.data}"}"""
        )
        assertTrue("blob file should exist for the node check", out.exists())
    }

    @Test
    fun wrongPasswordFailsCleanlyRatherThanThrowing() {
        val key = VaultCrypto.derive("not-the-password", VaultCrypto.decode(windowsSalt))
        val blob = VaultCrypto.Blob(iv = windowsIv, tag = windowsTag, data = windowsData)
        assertNull("a wrong key must return null, not throw or return garbage", VaultCrypto.open(key, blob))
    }

    @Test
    fun deriveIsSaltDependent() {
        // The trap #105 has to design around: same password, different salt,
        // different key — so a per-device salt makes synced blobs undecryptable.
        val a = VaultCrypto.derive(password, VaultCrypto.randomBytes(VaultCrypto.SALT_LEN))
        val b = VaultCrypto.derive(password, VaultCrypto.randomBytes(VaultCrypto.SALT_LEN))
        assertNotEquals(VaultCrypto.encode(a), VaultCrypto.encode(b))
    }

    @Test
    fun keyAndIvSizesMatchTheWindowsFormat() {
        val key = VaultCrypto.derive(password, VaultCrypto.decode(windowsSalt))
        assertEquals(32, key.size)
        assertEquals(12, VaultCrypto.decode(windowsIv).size)
        assertEquals(16, VaultCrypto.decode(windowsTag).size)
        assertEquals(16, VaultCrypto.decode(windowsSalt).size)
    }

    @Test
    fun tagIsStoredSeparatelyFromCiphertext() {
        // Regression guard for the JCE-vs-Node difference: the JCE appends the
        // tag to the ciphertext, vault.js keeps it apart. If seal() ever stops
        // splitting it, data grows by 16 bytes and Windows can't read it.
        val key = VaultCrypto.derive(password, VaultCrypto.decode(windowsSalt))
        val blob = VaultCrypto.seal(key, "\"x\"")
        assertEquals(16, VaultCrypto.decode(blob.tag).size)
        assertEquals(3, VaultCrypto.decode(blob.data).size) // "x" with quotes
    }
}
