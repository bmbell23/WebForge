package com.webforge.browser

/** #289: which tab to land on after closing the active one. Pure so it is unit-tested. */
object TabNav {
    /**
     * The entry BELOW [id] in [order] (a Persona's sidebar order), or the one ABOVE
     * when it was last. Null when [id] is absent or was the only entry.
     */
    fun afterClose(order: List<Int>, id: Int): Int? {
        val i = order.indexOf(id)
        if (i < 0) return null
        if (i + 1 < order.size) return order[i + 1]
        if (i > 0) return order[i - 1]
        return null
    }
}
