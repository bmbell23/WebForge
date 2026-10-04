package com.webforge.browser

/**
 * #186: which image sits under a long-press. The WebView's own long-click
 * never fires on pages that cancel `contextmenu` (most galleries do, to stop
 * saving), and a transparent overlay hides the <img> from `hitTestResult`.
 * So we ask the page itself: every element under the point, top to bottom,
 * looking through overlays for an <img>, a <video> poster or a CSS
 * background image.
 */
object ImageAt {
    /** [x]/[y] are physical pixels inside the WebView; the script turns them
     *  into CSS pixels (devicePixelRatio, then pinch zoom via visualViewport). */
    fun script(x: Float, y: Float): String = """
        (function(){
          var v = window.visualViewport, d = window.devicePixelRatio || 1;
          var s = v ? v.scale : 1, ox = v ? v.offsetLeft : 0, oy = v ? v.offsetTop : 0;
          var cx = ox + $x / d / s, cy = oy + $y / d / s;
          var els = document.elementsFromPoint ? document.elementsFromPoint(cx, cy) : [document.elementFromPoint(cx, cy)];
          for (var i = 0; i < els.length; i++) {
            var e = els[i];
            if (!e) continue;
            if (e.tagName === 'IMG' && (e.currentSrc || e.src)) return e.currentSrc || e.src;
            if (e.tagName === 'VIDEO' && e.poster) return e.poster;
            var b = getComputedStyle(e).backgroundImage;
            var m = b && b.match(/url\(["']?([^"')]+)["']?\)/);
            if (m) return new URL(m[1], document.baseURI).href;
          }
          return null;
        })()
    """.trimIndent()

    /** evaluateJavascript hands back JSON: `null` or a quoted string. */
    fun parse(json: String?): String? {
        if (json == null || json.length < 2 || json[0] != '"' || json.last() != '"') return null
        val s = json.substring(1, json.length - 1)
        val out = StringBuilder()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '\\' && i + 1 < s.length) {
                when (val n = s[i + 1]) {
                    'u' -> if (i + 5 < s.length) {
                        out.append(s.substring(i + 2, i + 6).toInt(16).toChar()); i += 6; continue
                    }
                    'n' -> out.append('\n')
                    't' -> out.append('\t')
                    else -> out.append(n) // \" \\ \/
                }
                i += 2
            } else {
                out.append(c); i++
            }
        }
        return out.toString().takeIf { it.isNotEmpty() }
    }
}
