package com.webforge.browser

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/**
 * #55: the Android master-password vault — the storage and unlock half, with all
 * the crypto delegated to [VaultCrypto] so it stays interop-tested against
 * `windows/vault.js`.
 *
 * Mirrors the Windows layout under `filesDir/vault/`:
 *   check.bin       {salt, iv, tag, data} sealing the verifier — a wrong password
 *                   fails the GCM tag, so this doubles as the password check.
 *   bio.bin         the vault key, wrapped by a Keystore key that requires
 *                   biometric auth. Convenience only: deleting it costs nothing
 *                   but a re-enrolment, and the password remains the truth.
 *   <name>.bin      arbitrary sealed payloads (#104 stores credentials here).
 *
 * The key exists only in memory while unlocked, exactly as on Windows.
 *
 * DIFFERENCE FROM WINDOWS, by decision: locking here gates *saved passwords*,
 * not the whole app. Browsing never waits on this. On Windows `locked = true`
 * bricks everything, which is right for a desktop and wrong for a phone you
 * pick up fifty times a day.
 */
object Vault {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val BIO_KEY_ALIAS = "webforge-vault-bio"

    private var key: ByteArray? = null

    private fun dir(ctx: Context) = File(ctx.filesDir, "vault")
    private fun file(ctx: Context, name: String) = File(dir(ctx), "$name.bin")

    fun isInitialized(ctx: Context) = file(ctx, "check").exists()

    fun isUnlocked() = key != null

    /** True once a biometric unlock has been enrolled over the password. */
    fun isBiometricEnrolled(ctx: Context) = file(ctx, "bio").exists()

    fun biometricAvailable() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P

    fun statusLine(ctx: Context) = when {
        !isInitialized(ctx) -> "No master password set"
        isUnlocked() -> "Unlocked"
        isBiometricEnrolled(ctx) -> "Locked · fingerprint or password"
        else -> "Locked · password required"
    }

    // --- password -----------------------------------------------------------

    fun setup(ctx: Context, password: String): Boolean {
        if (isInitialized(ctx) || password.isEmpty()) return false
        dir(ctx).mkdirs()
        val salt = VaultCrypto.randomBytes(VaultCrypto.SALT_LEN)
        val k = VaultCrypto.derive(password, salt)
        val blob = VaultCrypto.seal(k, VaultCrypto.VERIFIER_JSON)
        writeBlob(ctx, "check", blob, VaultCrypto.encode(salt))
        key = k
        return true
    }

    fun unlock(ctx: Context, password: String): Boolean {
        val blob = readBlob(ctx, "check") ?: return false
        val salt = blob.salt ?: return false
        val k = VaultCrypto.derive(password, VaultCrypto.decode(salt))
        // A wrong password throws on the GCM tag, so open() returning anything
        // at all already means the key is right; the compare is belt and braces.
        if (VaultCrypto.open(k, blob) != VaultCrypto.VERIFIER_JSON) return false
        key = k
        return true
    }

    fun lock() {
        key?.fill(0)
        key = null
    }

    /** Forgotten password: no recovery, same as Windows. Wipes everything. */
    fun reset(ctx: Context) {
        lock()
        dir(ctx).deleteRecursively()
        try {
            KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(BIO_KEY_ALIAS)
        } catch (_: Exception) {
        }
    }

    // --- biometric convenience layer ---------------------------------------

    /**
     * Wraps the in-memory vault key under a Keystore key that demands biometric
     * auth. Must be called while unlocked — there is nothing to wrap otherwise.
     * Returns the cipher to hand to BiometricPrompt, or null if unsupported.
     */
    fun beginBiometricEnrol(): Cipher? {
        if (key == null || !biometricAvailable()) return null
        return try {
            val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            if (!ks.containsAlias(BIO_KEY_ALIAS)) {
                KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).apply {
                    init(
                        KeyGenParameterSpec.Builder(
                            BIO_KEY_ALIAS,
                            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                        )
                            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                            .setUserAuthenticationRequired(true)
                            // Re-enrolling a fingerprint invalidates the key, which
                            // is the point: the wrap must not outlive the biometric
                            // set that authorised it.
                            .setInvalidatedByBiometricEnrollment(true)
                            .build()
                    )
                    generateKey()
                }
            }
            val secret = ks.getKey(BIO_KEY_ALIAS, null) as SecretKey
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, secret) }
        } catch (_: Exception) {
            null
        }
    }

    /** Call with the authenticated cipher from [beginBiometricEnrol]. */
    fun finishBiometricEnrol(ctx: Context, cipher: Cipher): Boolean {
        val k = key ?: return false
        return try {
            val wrapped = cipher.doFinal(k)
            val json = JSONObject()
                .put("iv", VaultCrypto.encode(cipher.iv))
                .put("key", VaultCrypto.encode(wrapped))
            dir(ctx).mkdirs()
            file(ctx, "bio").writeText(json.toString())
            true
        } catch (_: Exception) {
            false
        }
    }

    /** Returns the cipher to authenticate, or null if biometric isn't set up. */
    fun beginBiometricUnlock(ctx: Context): Cipher? {
        if (!isBiometricEnrolled(ctx) || !biometricAvailable()) return null
        return try {
            val json = JSONObject(file(ctx, "bio").readText())
            val iv = VaultCrypto.decode(json.getString("iv"))
            val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            val secret = ks.getKey(BIO_KEY_ALIAS, null) as SecretKey
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(VaultCrypto.TAG_LEN * 8, iv))
            }
        } catch (_: Exception) {
            // A biometric re-enrolment invalidates the Keystore key. That is not
            // an error state — drop the wrap and fall back to the password.
            clearBiometric(ctx)
            null
        }
    }

    /** Call with the authenticated cipher from [beginBiometricUnlock]. */
    fun finishBiometricUnlock(ctx: Context, cipher: Cipher): Boolean = try {
        val json = JSONObject(file(ctx, "bio").readText())
        key = cipher.doFinal(VaultCrypto.decode(json.getString("key")))
        true
    } catch (_: Exception) {
        false
    }

    fun clearBiometric(ctx: Context) {
        file(ctx, "bio").delete()
        try {
            KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(BIO_KEY_ALIAS)
        } catch (_: Exception) {
        }
    }

    // --- sealed payloads, for #104 -----------------------------------------

    fun readJson(ctx: Context, name: String): String? {
        val k = key ?: return null
        val blob = readBlob(ctx, name) ?: return null
        return VaultCrypto.open(k, blob)
    }

    fun writeJson(ctx: Context, name: String, json: String): Boolean {
        val k = key ?: return false
        return try {
            dir(ctx).mkdirs()
            writeBlob(ctx, name, VaultCrypto.seal(k, json), null)
            true
        } catch (_: Exception) {
            false
        }
    }

    // --- blob files ---------------------------------------------------------

    private fun writeBlob(ctx: Context, name: String, blob: VaultCrypto.Blob, salt: String?) {
        val json = JSONObject()
            .put("iv", blob.iv)
            .put("tag", blob.tag)
            .put("data", blob.data)
        if (salt != null) json.put("salt", salt)
        file(ctx, name).writeText(json.toString())
    }

    private fun readBlob(ctx: Context, name: String): VaultCrypto.Blob? = try {
        val json = JSONObject(file(ctx, name).readText())
        VaultCrypto.Blob(
            iv = json.getString("iv"),
            tag = json.getString("tag"),
            data = json.getString("data"),
            salt = if (json.has("salt")) json.getString("salt") else null,
        )
    } catch (_: Exception) {
        null
    }
}
