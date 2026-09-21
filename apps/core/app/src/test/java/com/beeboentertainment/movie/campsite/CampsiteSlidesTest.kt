package com.beeboentertainment.movie.campsite

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.net.HttpURLConnection
import java.net.URL

class CampsiteSlidesTest {
    private fun action(name: String, vararg fields: Pair<String, JsonElement>) = buildJsonObject {
        put("action", name); fields.forEach { put(it.first, it.second) }
    }
    @Test fun ownerControlsFilesClockAndHandover() {
        val dir = Files.createTempDirectory("slides-test").toFile()
        var clock = 1000L
        val slides = CampsiteSlides(dir) { clock }
        try {
            assertEquals(401, slides.handle(null, null, false).status)
            val start = slides.handle("a", "Alex", false, action("claim")).body
            val generation = start["generation"]!!
            assertEquals(409, slides.handle("b", "Sam", false, action("claim")).status)
            val mp4 = byteArrayOf(0,0,0,24,102,116,121,112,105,115,111,109)
            assertEquals(200, slides.upload("a", "Trip.mp4", generation.jsonPrimitive.content, "video/mp4", 12, mp4.inputStream()).status)
            val snapshot = slides.handle("b", "Sam", false).body
            val id = snapshot["items"]!!.jsonArray[0].jsonObject["id"]!!
            assertNotNull(slides.file(id.jsonPrimitive.content))
            val play = action("playback", "generation" to generation, "mediaId" to id, "position" to JsonPrimitive(4.0), "playing" to JsonPrimitive(true))
            assertEquals(403, slides.handle("b", "Sam", false, play).status)
            assertEquals(200, slides.handle("a", "Alex", false, play).status)
            clock += 3500
            assertEquals(7.5, slides.handle("b", "Sam", false).body["position"]!!.jsonPrimitive.double, .01)
            assertEquals(200, slides.handle("host", "Host", true, action("stop")).status)
            assertNull(slides.file(id.jsonPrimitive.content))
            assertEquals(200, slides.handle("b", "Sam", false, action("claim")).status)
            assertEquals(403, slides.upload("a", "old.mp4", generation.jsonPrimitive.content, "video/mp4",12,mp4.inputStream()).status)
            clock += 120001
            assertEquals("", slides.handle("a", "Alex", false).body["presenter"]!!.jsonPrimitive.content)
        } finally { slides.close(); dir.deleteRecursively() }
    }
    @Test fun rejectUnselectedUnsupportedOversizedAndInterruptedFiles() {
        val dir = Files.createTempDirectory("slides-limits").toFile(); val slides = CampsiteSlides(dir)
        try {
            val g = slides.handle("a", "Alex", false, action("claim")).body["generation"]!!.jsonPrimitive.content
            assertEquals(415, slides.upload("a", "x.svg",g,"image/svg+xml",12,ByteArray(12).inputStream()).status)
            assertEquals(413, slides.upload("a", "x.jpg",g,"image/jpeg",21L*1024*1024,ByteArray(0).inputStream()).status)
            assertEquals(415, slides.upload("a", "x.jpg",g,"image/jpeg",12,ByteArray(12).inputStream()).status)
            val jpg = byteArrayOf(0xff.toByte(),0xd8.toByte(),0xff.toByte(),0,0,0,0,0,0,0,0,0)
            assertEquals(400, slides.upload("a","x.jpg",g,"image/jpeg",100,jpg.inputStream()).status)
            assertTrue(dir.walkTopDown().none { it.isFile })
        } finally { slides.close(); dir.deleteRecursively() }
    }
    @Test fun httpGuestUploadRangeAndControlPermissions() {
        val dir = Files.createTempDirectory("slides-http").toFile()
        val server = CampsiteServer(0, { emptyList() }, { null }, slidesDirectory = dir, slidesPage = { "sharing" })
        server.start()
        fun connection(path: String, cookie: String? = null) = (URL("http://127.0.0.1:${server.boundPort}$path").openConnection() as HttpURLConnection).apply {
            connectTimeout=3000;readTimeout=3000;instanceFollowRedirects=false
            if(cookie!=null)setRequestProperty("Cookie",cookie)
        }
        fun join(name: String): String {
            val c=connection("/join?name=$name&next=slides")
            try { assertEquals(302,c.responseCode);assertEquals("/slides",c.getHeaderField("Location"));return c.headerFields.entries.filter { it.key.equals("Set-Cookie",true) }.flatMap{it.value}.joinToString("; "){it.substringBefore(';')} } finally {c.disconnect()}
        }
        fun post(cookie:String, body:String): Pair<Int,JsonObject> {
            val c=connection("/api/slides",cookie)
            try {c.requestMethod="POST";c.setRequestProperty("Content-Type","application/json");c.setRequestProperty("X-Beebo-Slides","1");c.doOutput=true;c.outputStream.use{it.write(body.toByteArray())};val status=c.responseCode;return status to Json.parseToJsonElement((if(status<400)c.inputStream else c.errorStream).bufferedReader().readText()).jsonObject} finally {c.disconnect()}
        }
        try {
            val a=join("Alex");val b=join("Sam");val c=join("Casey")
            val claimed=post(a,"""{"action":"claim"}""").second
            val generation=claimed["generation"]!!.jsonPrimitive.content
            val upload=connection("/api/slides/upload?generation=$generation&name=photo.jpg",a)
            val body:JsonObject
            try {
                upload.requestMethod="POST";upload.setRequestProperty("X-Beebo-Slides","1");upload.setRequestProperty("Content-Type","image/jpeg");upload.doOutput=true
                upload.outputStream.use{it.write(byteArrayOf(-1,-40,-1,0,0,0,0,0,0,0,0,0))}
                assertEquals(200,upload.responseCode);body=Json.parseToJsonElement(upload.inputStream.bufferedReader().readText()).jsonObject
            } finally {upload.disconnect()}
            val id=body["items"]!!.jsonArray.first().jsonObject["id"]!!.jsonPrimitive.content
            for(viewer in listOf(b,c)) {
                val file=connection("/slides/file?id=$id",viewer)
                try {file.setRequestProperty("Range","bytes=3-5");assertEquals(206,file.responseCode);assertEquals(3,file.inputStream.readBytes().size);assertEquals("image/jpeg",file.contentType)} finally{file.disconnect()}
            }
            val denied=connection("/slides/file?id=$id")
            try {assertEquals(404,denied.responseCode)} finally{denied.disconnect()}
            assertEquals(403,post(b,"""{"action":"select","generation":"$generation","index":0}""").first)
            java.net.Socket("127.0.0.1", server.boundPort).use { socket ->
                socket.soTimeout = 3000
                val request = "POST /api/slides HTTP/1.1\r\nHost: 127.0.0.1:${server.boundPort}\r\nOrigin: https://elsewhere.invalid\r\nX-Beebo-Slides: 1\r\nCookie: $a\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
                socket.getOutputStream().write(request.toByteArray())
                assertTrue(socket.getInputStream().bufferedReader().readText().startsWith("HTTP/1.1 403"))
            }
        } finally {server.stop();dir.deleteRecursively()}
    }
}
