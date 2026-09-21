package com.beeboentertainment.movie.campsite

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.SocketTimeoutException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class CampsiteWebSocketTest {
    private val ws = CampsiteWebSocket
    private val mask = byteArrayOf(0x37, 0xfa.toByte(), 0x21, 0x3d)

    private fun frame(opcode: Int, payload: ByteArray, fin: Boolean = true, masked: Boolean = true): ByteArray {
        val out = ByteArrayOutputStream()
        // hand-built so the test does not depend on the writer it is checking
        out.write((if (fin) 0x80 else 0) or opcode)
        val m = if (masked) 0x80 else 0
        when {
            payload.size < 126 -> out.write(m or payload.size)
            payload.size <= 0xFFFF -> { out.write(m or 126); out.write(payload.size shr 8); out.write(payload.size and 0xFF) }
            else -> { out.write(m or 127); for (s in 56 downTo 0 step 8) out.write(((payload.size.toLong() shr s) and 0xFF).toInt()) }
        }
        if (masked) {
            out.write(mask)
            out.write(ByteArray(payload.size) { (payload[it].toInt() xor mask[it and 3].toInt()).toByte() })
        } else out.write(payload)
        return out.toByteArray()
    }

    private fun reader(bytes: ByteArray) = CampsiteWebSocket.Reader(ByteArrayInputStream(bytes))

    @Test fun acceptKeyMatchesTheRfc6455Example() {
        assertEquals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", ws.acceptKey("dGhlIHNhbXBsZSBub25jZQ=="))
    }

    @Test fun base64MatchesTheJdkAndRejectsGarbage() {
        val rnd = java.util.Random(7)
        for (len in 0..40) {
            val bytes = ByteArray(len).also { rnd.nextBytes(it) }
            val text = ws.base64(bytes)
            assertEquals(java.util.Base64.getEncoder().encodeToString(bytes), text)
            assertArrayEquals(bytes, ws.base64Decode(text))
        }
        assertNull(ws.base64Decode("abc"))
        assertNull(ws.base64Decode("ab=c"))
        assertNull(ws.base64Decode("a!cd"))
    }

    @Test fun clientKeyMustBeSixteenBytesOfBase64() {
        assertTrue(ws.isValidClientKey("dGhlIHNhbXBsZSBub25jZQ=="))
        assertFalse(ws.isValidClientKey(null))
        assertFalse(ws.isValidClientKey("short"))
        assertFalse(ws.isValidClientKey("dGhlIHNhbXBsZSBub25jZQ=A"))
        assertFalse(ws.isValidClientKey("dGhlIHNhbXBsZSBub25jZQ\r\n"))
    }

    @Test fun upgradeRequestNeedsAllTheHeaders() {
        val good = mapOf("upgrade" to "websocket", "connection" to "keep-alive, Upgrade", "sec-websocket-version" to "13",
            "sec-websocket-key" to "dGhlIHNhbXBsZSBub25jZQ==")
        assertTrue(ws.isUpgradeRequest("GET", good))
        assertFalse(ws.isUpgradeRequest("POST", good))
        assertFalse(ws.isUpgradeRequest("GET", good - "upgrade"))
        assertFalse(ws.isUpgradeRequest("GET", good + ("sec-websocket-version" to "8")))
        assertFalse(ws.isUpgradeRequest("GET", good + ("connection" to "close")))
    }

    @Test fun readsMaskedTextFrames() {
        val r = reader(frame(ws.OP_TEXT, "hello é".toByteArray()))
        val m = r.next() as CampsiteWebSocket.Message
        assertEquals(ws.OP_TEXT, m.opcode)
        assertEquals("hello é", m.text)
        assertNull(r.next())
    }

    @Test fun readsMediumLengthFrames() {
        val payload = ByteArray(300) { (it % 250).toByte() }
        val m = reader(frame(ws.OP_TEXT, payload)).next() as CampsiteWebSocket.Message
        assertArrayEquals(payload, m.payload)
    }

    @Test fun reassemblesFragmentedMessages() {
        val bytes = frame(ws.OP_TEXT, "hel".toByteArray(), fin = false) +
            frame(ws.OP_PING, "p".toByteArray()) + // control frames may interleave
            frame(ws.OP_CONTINUATION, "lo".toByteArray(), fin = true)
        val r = reader(bytes)
        assertEquals(ws.OP_PING, (r.next() as CampsiteWebSocket.Message).opcode)
        assertEquals("hello", (r.next() as CampsiteWebSocket.Message).text)
    }

    private fun assertProtocolError(code: Int, bytes: ByteArray) {
        try { reader(bytes).next(); fail("expected a protocol error") } catch (e: CampsiteWebSocket.ProtocolException) { assertEquals(code, e.closeCode) }
    }

    @Test fun refusesUnmaskedClientFrames() = assertProtocolError(ws.CLOSE_PROTOCOL_ERROR, frame(ws.OP_TEXT, "x".toByteArray(), masked = false))

    @Test fun refusesReservedBitsAndUnknownOpcodes() {
        val rsv = frame(ws.OP_TEXT, "x".toByteArray()); rsv[0] = (rsv[0].toInt() or 0x40).toByte()
        assertProtocolError(ws.CLOSE_PROTOCOL_ERROR, rsv)
        assertProtocolError(ws.CLOSE_PROTOCOL_ERROR, frame(0x3, "x".toByteArray()))
    }

    @Test fun refusesFragmentedOrOversizedControlFrames() {
        assertProtocolError(ws.CLOSE_PROTOCOL_ERROR, frame(ws.OP_PING, "x".toByteArray(), fin = false))
        assertProtocolError(ws.CLOSE_PROTOCOL_ERROR, frame(ws.OP_PING, ByteArray(126)))
    }

    @Test fun refusesStrayContinuationsAndNestedMessages() {
        assertProtocolError(ws.CLOSE_PROTOCOL_ERROR, frame(ws.OP_CONTINUATION, "x".toByteArray()))
        assertProtocolError(ws.CLOSE_PROTOCOL_ERROR, frame(ws.OP_TEXT, "a".toByteArray(), fin = false) + frame(ws.OP_TEXT, "b".toByteArray()))
    }

    @Test fun oversizedFramesAreRefusedBeforeAnyPayloadIsRead() {
        // Header only: announces 5000 bytes (over the 4096 cap) and then the stream simply ends.
        val header = byteArrayOf(0x81.toByte(), (0x80 or 126).toByte(), (5000 shr 8).toByte(), (5000 and 0xFF).toByte(), 1, 2, 3, 4)
        assertProtocolError(ws.CLOSE_TOO_BIG, header)
        // A 64-bit length of 2^40 must not be allocated.
        val huge = byteArrayOf(0x81.toByte(), (0x80 or 127).toByte(), 0, 0, 1, 0, 0, 0, 0, 0, 1, 2, 3, 4)
        assertProtocolError(ws.CLOSE_TOO_BIG, huge)
        // Fragments that add up past the cap are refused too.
        val chunk = ByteArray(3000)
        assertProtocolError(ws.CLOSE_TOO_BIG, frame(ws.OP_TEXT, chunk, fin = false) + frame(ws.OP_CONTINUATION, chunk, fin = false) + frame(ws.OP_CONTINUATION, chunk))
    }

    @Test fun aTimeoutBetweenFramesIsIdleButInsideAFrameIsFatal() {
        var calls = 0
        val idleThenData = object : java.io.InputStream() {
            override fun read(): Int { calls++; if (calls == 1) throw SocketTimeoutException(); return -1 }
        }
        assertSame(CampsiteWebSocket.Idle, CampsiteWebSocket.Reader(idleThenData).next())
        val cutOff = object : java.io.InputStream() {
            var n = 0
            override fun read(): Int { n++; return when (n) { 1 -> 0x81; 2 -> 0x80 or 5; else -> throw SocketTimeoutException() } }
        }
        try { CampsiteWebSocket.Reader(cutOff).next(); fail() } catch (e: SocketTimeoutException) { /* the connection ends; state is unrecoverable */ }
    }

    @Test fun writerOutputRoundTripsThroughTheReader() {
        for (size in listOf(0, 5, 125, 126, 300, 4096)) {
            val payload = ByteArray(size) { (it * 7).toByte() }
            val out = ByteArrayOutputStream()
            ws.writeFrame(out, ws.OP_TEXT, payload, maskKey = mask)
            val m = reader(out.toByteArray()).next() as CampsiteWebSocket.Message
            assertArrayEquals("size $size", payload, m.payload)
        }
        // Server frames are unmasked: 2-byte header for a short payload.
        val server = ByteArrayOutputStream()
        ws.writeFrame(server, ws.OP_TEXT, "hi".toByteArray())
        assertArrayEquals(byteArrayOf(0x81.toByte(), 2, 'h'.code.toByte(), 'i'.code.toByte()), server.toByteArray())
    }

    @Test fun closePayloadCarriesTheCode() {
        assertArrayEquals(byteArrayOf(0x03, 0xE9.toByte()), ws.closePayload(1001))
    }
}
