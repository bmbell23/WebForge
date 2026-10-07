package com.webforge.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** #289: focus after closing the active tab. */
class TabNavTest {
    @Test fun middle_lands_below() = assertEquals(3, TabNav.afterClose(listOf(1, 2, 3), 2))
    @Test fun first_lands_below() = assertEquals(2, TabNav.afterClose(listOf(1, 2, 3), 1))
    @Test fun last_lands_above() = assertEquals(2, TabNav.afterClose(listOf(1, 2, 3), 3))
    @Test fun only_tab_has_no_neighbor() = assertNull(TabNav.afterClose(listOf(7), 7))
    @Test fun absent_id_gives_null() = assertNull(TabNav.afterClose(listOf(1, 2, 3), 9))
    @Test fun empty_list_gives_null() = assertNull(TabNav.afterClose(emptyList(), 1))
}
