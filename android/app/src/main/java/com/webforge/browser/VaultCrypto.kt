package com.webforge.browser

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import com.lambdaworks.crypto.SCrypt

/**
 * #55: the crypto half of the vault, byte-for-byte compatible with
 * `windows/vault.js`. Deliberately contains **no Android APIs** — not
 * `android.util.Base64`, not `org.json` — so the Windows-interop proof can run
 * as a plain JVM unit test (`VaultCryptoTest`) instead of needing a device.
 *
 * Compatibility rules, all of which the interop test pins down:
 *  - key = scrypt(password, salt, N=32768, r=8, p=1, dkLen=32)
 *  - AES-256-GCM, 12-byte IV, 128-bit tag
 *  - the tag is stored SEPARATELY from the ciphertext. Node's crypto returns it
 *    from `cipher.getAuthTag()`; the JCE appends it to the ciphertext instead,
 *    so [seal] splits it off and [open] joins it back on. Getting this wrong is
 *    invisible until a real cross-device decrypt fails.
 *  - payloads are `JSON.stringify(value)` — so sealing the verifier string means
 *    sealing `"webforge-vault-ok-v1"` WITH the quotes, not the bare characters.
 */
object VaultCrypto {
    const val VERIFIER = "webforge-vault-ok-v1"

    /** What vault.js actually seals: `JSON.stringify(VERIFIER)`, quotes included. */
    const val VERIFIER_JSON = "\"$VERIFIER\""

    const val SCRYPT_N = 32768
    const val SCRYPT_R = 8
    const val SCRYPT_P = 1
    const val KEY_LEN = 32
    const val IV_LEN = 12
    const val TAG_LEN = 16
    const val SALT_LEN = 16

    /** A sealed payload. [salt] is only set on the check blob, matching vault.js. */
    data class Blob(val iv: String, val tag: String, val data: String, val salt: String? = null)

    private val b64: Base64.Encoder = Base64.getEncoder()
    private val b64d: Base64.Decoder = Base64.getDecoder()

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { SecureRandom().nextBytes(it) }

    /**
     * `scryptJ` is the pure-Java path, chosen deliberately over `scrypt()`: that
     * one prefers a JNI build, and the APK ships none (see build.gradle), so the
     * phone would fall back to Java while the unit test used the native. Pinning
     * it here means the interop test exercises exactly what runs on the device.
     */
    fun derive(password: String, salt: ByteArray): ByteArray =
        SCrypt.scryptJ(password.toByteArray(Charsets.UTF_8), salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LEN)

    fun seal(key: ByteArray, json: String): Blob {
        val iv = randomBytes(IV_LEN)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_LEN * 8, iv))
        val out = cipher.doFinal(json.toByteArray(Charsets.UTF_8))
        // JCE hands back ciphertext||tag; vault.js expects them apart.
        val split = out.size - TAG_LEN
        return Blob(
            iv = b64.encodeToString(iv),
            tag = b64.encodeToString(out.copyOfRange(split, out.size)),
            data = b64.encodeToString(out.copyOfRange(0, split)),
        )
    }

    /** Returns the JSON text, or null if the key is wrong or the blob is damaged. */
    fun open(key: ByteArray, blob: Blob): String? = try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(TAG_LEN * 8, b64d.decode(blob.iv)),
        )
        // Re-join what seal() split: the JCE wants ciphertext||tag in one buffer.
        val joined = b64d.decode(blob.data) + b64d.decode(blob.tag)
        String(cipher.doFinal(joined), Charsets.UTF_8)
    } catch (_: Exception) {
        null // wrong password (GCM tag mismatch) or corrupt blob — same answer
    }

    fun encode(bytes: ByteArray): String = b64.encodeToString(bytes)

    fun decode(text: String): ByteArray = b64d.decode(text)
}
