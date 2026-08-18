package com.webforge.browser

/**
 * #134: what User-Agent we tell websites we are.
 *
 * Sites with a "supported browsers" allowlist (Chase and most banks) refuse to
 * let you sign in when the UA names a browser they don't recognise — not
 * because anything is missing, but because they pattern-match a brand. The
 * Windows side has the same problem for a different reason (see
 * windows/useragent.js), so the two platforms fix it in the same spirit: take
 * whatever the engine generated and SUBTRACT the giveaway tokens, never
 * hardcode a UA of our own. A hardcoded string rots into claiming an old Chrome
 * as soon as the engine updates underneath it — and on Android the engine
 * updates through Play without us shipping anything at all, so a hardcoded UA
 * would rot silently and fast.
 *
 * Android System WebView's default looks like:
 *
 *   Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/X; wv) AppleWebKit/537.36
 *     (KHTML, like Gecko) Version/4.0 Chrome/132.0.0.0 Mobile Safari/537.36
 *
 * Two tokens mark it as an embedded WebView rather than Chrome for Android:
 * the `; wv` inside the platform parentheses, and `Version/4.0` (an Android
 * Browser leftover that real Chrome does not send). Removing both leaves a
 * string identical to mobile Chrome's.
 */
object UserAgent {

    private val WV = Regex("""\s*;\s*wv""", RegexOption.IGNORE_CASE)
    private val VERSION = Regex("""\s*\bVersion/\S+""", RegexOption.IGNORE_CASE)
    private val GAPS = Regex("""\s{2,}""")

    /**
     * Strip the WebView giveaway tokens from a User-Agent string. Everything
     * else — platform, device, AppleWebKit, Chrome and Safari tokens — is left
     * exactly as the engine wrote it.
     */
    fun clean(ua: String?): String {
        if (ua.isNullOrEmpty()) return ""
        return ua
            .replace(WV, "")
            .replace(VERSION, "")
            // Defensive: never ship a UA with ragged spacing — that alone reads
            // as synthetic to a sniffer.
            .replace(GAPS, " ")
            .trim()
    }
}
