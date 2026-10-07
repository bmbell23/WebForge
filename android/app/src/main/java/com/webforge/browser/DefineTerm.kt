package com.webforge.browser

/**
 * #286: which selected text is a definable word or short phrase.
 *
 * The SAME rule lives in windows/defineterm.js and server/sync.py (clean_term),
 * with the same test cases in each. Keep all three in step:
 *   1. smart quotes become plain ones (don’t -> don't)
 *   2. whitespace runs collapse to one space
 *   3. leading/trailing quotes, brackets, , . ; : ! ? … and hyphens are dropped
 *   4. valid only at 1-64 characters, each a letter, digit, space, ' or -
 */
object DefineTerm {
    const val MAX = 64
    private const val WS = " \t\n\r\u000c\u000b "
    private const val EDGE = WS + "\"'`,.;:!?()[]{}<>«»…-"
    private val WS_RE = Regex("[$WS]+")

    fun clean(s: String?): String? {
        if (s == null) return null
        val t = s
            .replace('‘', '\'').replace('’', '\'')
            .replace('“', '"').replace('”', '"')
            .replace(WS_RE, " ")
            .trim { it in EDGE }
        if (t.isEmpty() || t.codePointCount(0, t.length) > MAX) return null
        var i = 0
        while (i < t.length) {
            val cp = t.codePointAt(i)
            val ok = Character.isLetter(cp) || Character.getType(cp) == Character.DECIMAL_DIGIT_NUMBER.toInt() ||
                cp == ' '.code || cp == '\''.code || cp == '-'.code
            if (!ok) return null
            i += Character.charCount(cp)
        }
        return t
    }

    const val DICTIONARY_URL = "http://100.69.184.113:8098/"
    private const val DEFINE_URL = "http://100.69.184.113:8013/define"

    /** Daphne's dictionary page for an already-cleaned term. */
    fun dictionaryUrl(term: String): String =
        DICTIONARY_URL + java.net.URLEncoder.encode(term, "UTF-8").replace("+", "%20")

    /** Fire and forget: tell the sync server what was looked up. Failures only reach the log. */
    fun send(term: String, pageUrl: String?) {
        Thread {
            try {
                val body = org.json.JSONObject().put("term", term).put("url", pageUrl ?: "").toString()
                val conn = java.net.URL(DEFINE_URL).openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toByteArray()) }
                conn.inputStream.use { it.readBytes() }
                conn.disconnect()
            } catch (e: Exception) {
                android.util.Log.w("DefineTerm", "define failed", e)
            }
        }.start()
    }
}
