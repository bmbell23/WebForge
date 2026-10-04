package com.webforge.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** #177. Mirrors `windows/stash.test.js` (request body and status wording). */
class StashTest {
    private val page = "https://www.hqgals.com/gallery/jane-doe-red-dress-12345/"
    private val g = Stash.Meta(
        title = "Jane Doe in Red Dress", performers = listOf("Jane Doe"), studio = "MetArt",
        site = "hqgals.com", date = "2026-09-30", tags = listOf("redhead", "dress"),
        imageUrls = listOf(
            "https://cdn.hqgals.com/12345/01.jpg", "https://cdn.hqgals.com/12345/02.JPG",
            "https://cdn.hqgals.com/12345/03.webp?w=1",
        ),
    )

    @Test
    fun endpoint_sits_beside_the_ytdlp_route() {
        assertEquals("http://100.69.184.113:8001/api/download/stash",
            Stash.endpoint("http://100.69.184.113:8001/api/download/ytdlp"))
    }

    @Test
    fun three_images_make_a_gallery() {
        assertTrue(Stash.isGallery(g))
        assertFalse(Stash.isGallery(g.copy(imageUrls = g.imageUrls.take(2))))
        assertFalse(Stash.isGallery(null))
    }

    @Test
    fun gallery_body_carries_images_and_drops_data_urls() {
        val b = Stash.body("gallery", page, page, g.copy(imageUrls = g.imageUrls + "data:image/png;base64,AA"))!!
        assertEquals("gallery", b.kind)
        assertEquals(page, b.pageUrl)
        assertEquals(listOf("Jane Doe"), b.performers)
        assertEquals(3, b.imageUrls!!.size)
        assertTrue(b.toJson().contains("\"image_urls\":["))
    }

    @Test
    fun media_body_has_no_image_list_and_keeps_its_page() {
        val m = Stash.body("media", "https://cdn.x.com/a.jpg", "https://x.com/p", g)!!
        assertNull(m.imageUrls)
        assertFalse(m.toJson().contains("image_urls"))
        assertEquals("https://x.com/p", m.pageUrl)
    }

    @Test
    fun a_bare_body_falls_back_to_the_url() {
        val bare = Stash.body("video", "https://x.com/v", "about:blank", null)!!
        assertEquals("https://x.com/v", bare.pageUrl)
        assertEquals("x.com", bare.site)
        assertNull(bare.title)
        assertNull(Stash.body("video", "https://x.com/v", "", Stash.Meta(date = "yesterday"))!!.date)
    }

    @Test
    fun rejects_unknown_kind_and_unsendable_url() {
        assertNull(Stash.body("bogus", page, page))
        assertNull(Stash.body("media", "data:image/png;base64,AA", page))
    }

    @Test
    fun blank_list_entries_are_dropped() {
        val b = Stash.body("video", "https://x.com/v", "https://x.com/v", Stash.Meta(tags = listOf("a", " ", "")))!!
        assertEquals(listOf("a"), b.tags)
    }

    @Test
    fun json_is_escaped_and_complete() {
        val b = Stash.body("media", "https://x.com/a.jpg", "https://x.com/p",
            Stash.Meta(title = "He said \"hi\" \\ ok\nline", date = "2026-01-02"))!!
        assertEquals(
            "{\"kind\":\"media\",\"url\":\"https://x.com/a.jpg\",\"page_url\":\"https://x.com/p\",\"meta\":" +
                "{\"title\":\"He said \\\"hi\\\" \\\\ ok\\nline\",\"performers\":[],\"studio\":null," +
                "\"site\":\"x.com\",\"date\":\"2026-01-02\",\"tags\":[]}}",
            b.toJson())
        assertNotNull(b)
    }

    @Test
    fun status_wording_matches_windows() {
        assertEquals("Stash: downloading gallery…", Stash.statusText("gallery", Stash.Status("downloading", null, null)))
        assertEquals("Stash: waiting for the file…", Stash.statusText("media", null))
        assertEquals("Stash: video queued", Stash.statusText("video", Stash.Status("queued", null, null)))
        assertEquals("Stash: scanning item…", Stash.statusText("zzz", Stash.Status("scanning", null, null)))
        assertEquals("Stash: tagging file…", Stash.statusText("media", Stash.Status("tagging", null, null)))
        assertEquals("Stash: weird", Stash.statusText("media", Stash.Status("weird", null, null)))
    }

    @Test
    fun done_names_the_folder_and_failed_gives_the_reason() {
        assertEquals("Added gallery to Stash: 2026-10-04 1554 - Jane Doe - Red",
            Stash.statusText("gallery", Stash.Status("done", null, "/data/Pictures/Downloads/2026-10-04 1554 - Jane Doe - Red")))
        assertEquals("Added file to Stash", Stash.statusText("media", Stash.Status("done", null, null)))
        assertEquals("Stash file failed: Unsupported URL", Stash.statusText("media", Stash.Status("failed", "Unsupported URL", null)))
        assertEquals("Stash file failed: unknown error", Stash.statusText("media", Stash.Status("failed", null, null)))
        assertEquals(300 + "Stash file failed: ".length, Stash.statusText("media", Stash.Status("failed", "x".repeat(500), null)).length)
    }

    @Test
    fun finished_only_for_done_or_failed() {
        assertTrue(Stash.finished(Stash.Status("done", null, null)))
        assertTrue(Stash.finished(Stash.Status("failed", null, null)))
        assertFalse(Stash.finished(Stash.Status("tagging", null, null)))
        assertFalse(Stash.finished(null))
    }
}
