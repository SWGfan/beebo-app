package com.beeboentertainment.movie.campsite

import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.SocketTimeoutException
import java.security.MessageDigest

/**
 * A deliberately small, dependency-free WebSocket (RFC 6455) - just enough for the synced-music
 * channel between the host phone and browsers on its Wi-Fi.
 *
 * Why WebSocket rather than long-poll or Server-Sent Events: the clock-sync exchange needs a
 * *persistent, bidirectional* pipe with no per-message connection set-up. CampsiteServer answers
 * every plain HTTP request with "Connection: close", so an HTTP-based ping would put a fresh TCP
 * handshake inside every measured round trip (asymmetric and jittery), and SSE is one-way (every
 * ping would still need its own POST). A WebSocket keeps one TCP connection open, browsers ship it
 * everywhere, and the whole protocol we need is ~150 lines: the opening handshake, text frames,
 * ping/pong, close, client-to-server masking and hard size limits.
 *
 * What is intentionally NOT here: extensions (permessage-deflate is never negotiated), subprotocols,
 * binary payloads (rejected), and 64-bit lengths (anything over [MAX_INCOMING_BYTES] is refused
 * before a single payload byte is read).
 */
internal object CampsiteWebSocket {

    const val GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    const val OP_CONTINUATION = 0x0
    const val OP_TEXT = 0x1
    const val OP_BINARY = 0x2
    const val OP_CLOSE = 0x8
    const val OP_PING = 0x9
    const val OP_PONG = 0xA

    const val CLOSE_NORMAL = 1000
    const val CLOSE_GOING_AWAY = 1001
    const val CLOSE_PROTOCOL_ERROR = 1002
    const val CLOSE_UNSUPPORTED = 1003
    const val CLOSE_POLICY = 1008
    const val CLOSE_TOO_BIG = 1009
    const val CLOSE_INTERNAL = 1011

    /** Largest message we accept from a browser. Real ones are well under 1 KB. */
    const val MAX_INCOMING_BYTES = 4096

    /** `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`. */
    fun acceptKey(clientKey: String): String {
        val digest = MessageDigest.getInstance("SHA-1").digest((clientKey.trim() + GUID).toByteArray(Charsets.US_ASCII))
        return base64(digest)
    }

    /** A client key is 16 random bytes in base64: 24 characters ending in "==". */
    fun isValidClientKey(key: String?): Boolean {
        val k = key?.trim() ?: return false
        if (k.length != 24 || !k.endsWith("==")) return false
        return k.all { it.isLetterOrDigit() && it.code < 128 || it == '+' || it == '/' || it == '=' } &&
            base64Decode(k)?.size == 16
    }

    /**
     * Whether these (lower-cased-name) request headers ask for a WebSocket upgrade. Does not judge
     * origin or cookies - the caller does, because that is server policy, not protocol.
     */
    fun isUpgradeRequest(method: String, headers: Map<String, String>): Boolean =
        method == "GET" &&
            headers["upgrade"]?.trim()?.equals("websocket", ignoreCase = true) == true &&
            headers["connection"]?.split(',')?.any { it.trim().equals("upgrade", ignoreCase = true) } == true &&
            headers["sec-websocket-version"]?.trim() == "13" &&
            isValidClientKey(headers["sec-websocket-key"])

    fun handshakeResponse(clientKey: String): ByteArray =
        ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: ${acceptKey(clientKey)}\r\nCache-Control: no-store\r\n\r\n").toByteArray(Charsets.US_ASCII)

    // ---- frames ------------------------------------------------------------------------------

    /** One complete message after fragments are reassembled, or a control frame. */
    class Message(val opcode: Int, val payload: ByteArray) {
        val text: String get() = String(payload, Charsets.UTF_8)
    }

    /** What went wrong with a frame; the connection answers with [closeCode] and hangs up. */
    class ProtocolException(val closeCode: Int, message: String) : Exception(message)

    /** Returned by [Reader.next] when the socket read timed out between frames (nothing arrived). */
    object Idle

    /**
     * Reads frames off a stream. Not thread-safe: one reader thread per connection.
     *
     * A read timeout *between* frames is reported as [Idle] so the caller can send a keep-alive
     * ping; a timeout in the middle of a frame is fatal, because the parse position would be lost.
     */
    class Reader(private val input: InputStream, private val maxMessage: Int = MAX_INCOMING_BYTES, private val requireMask: Boolean = true) {
        private var fragments: ByteArrayOutputStream? = null
        private var fragmentOpcode = 0

        /** The next data or control message, [Idle], or null on a clean end of stream. */
        fun next(): Any? {
            while (true) {
                val first = try {
                    input.read()
                } catch (e: SocketTimeoutException) {
                    return Idle
                }
                if (first < 0) return null
                val frame = readRest(first)
                val op = frame.opcode
                if (op >= 0x8) {
                    if (!frame.fin || frame.payload.size > 125) throw ProtocolException(CLOSE_PROTOCOL_ERROR, "bad control frame")
                    return Message(op, frame.payload)
                }
                if (op == OP_TEXT || op == OP_BINARY) {
                    if (fragments != null) throw ProtocolException(CLOSE_PROTOCOL_ERROR, "new message inside a fragmented one")
                    if (frame.fin) return Message(op, frame.payload)
                    fragments = ByteArrayOutputStream().also { it.write(frame.payload) }
                    fragmentOpcode = op
                } else if (op == OP_CONTINUATION) {
                    val buffer = fragments ?: throw ProtocolException(CLOSE_PROTOCOL_ERROR, "stray continuation")
                    if (buffer.size() + frame.payload.size > maxMessage) throw ProtocolException(CLOSE_TOO_BIG, "message too big")
                    buffer.write(frame.payload)
                    if (frame.fin) {
                        fragments = null
                        return Message(fragmentOpcode, buffer.toByteArray())
                    }
                } else {
                    throw ProtocolException(CLOSE_PROTOCOL_ERROR, "unknown opcode $op")
                }
            }
        }

        private class Frame(val fin: Boolean, val opcode: Int, val payload: ByteArray)

        private fun readRest(first: Int): Frame {
            if (first and 0x70 != 0) throw ProtocolException(CLOSE_PROTOCOL_ERROR, "reserved bits set")
            val fin = first and 0x80 != 0
            val opcode = first and 0x0F
            val second = readByte()
            val masked = second and 0x80 != 0
            if (requireMask && !masked) throw ProtocolException(CLOSE_PROTOCOL_ERROR, "client frames must be masked")
            var length = (second and 0x7F).toLong()
            if (length == 126L) length = ((readByte() shl 8) or readByte()).toLong()
            else if (length == 127L) {
                var l = 0L
                repeat(8) { l = (l shl 8) or readByte().toLong() }
                length = l
            }
            // Refuse before reading a single payload byte, so a huge announced length costs nothing.
            if (length < 0 || length > maxMessage) throw ProtocolException(CLOSE_TOO_BIG, "frame too big")
            val mask = ByteArray(4)
            if (masked) readFully(mask)
            val payload = ByteArray(length.toInt())
            readFully(payload)
            if (masked) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()
            return Frame(fin, opcode, payload)
        }

        private fun readByte(): Int {
            val b = input.read()
            if (b < 0) throw EOFException()
            return b
        }

        private fun readFully(buffer: ByteArray) {
            var offset = 0
            while (offset < buffer.size) {
                val n = input.read(buffer, offset, buffer.size - offset)
                if (n < 0) throw EOFException()
                offset += n
            }
        }
    }

    /**
     * Writes one unfragmented frame. Servers send unmasked; [maskKey] (4 bytes) is for the client
     * side, which exists here only so tests can drive the real server over a real socket.
     */
    fun writeFrame(out: OutputStream, opcode: Int, payload: ByteArray, maskKey: ByteArray? = null) {
        val header = ByteArrayOutputStream(14)
        header.write(0x80 or opcode)
        val maskBit = if (maskKey != null) 0x80 else 0
        when {
            payload.size < 126 -> header.write(maskBit or payload.size)
            payload.size <= 0xFFFF -> { header.write(maskBit or 126); header.write(payload.size shr 8); header.write(payload.size and 0xFF) }
            else -> {
                header.write(maskBit or 127)
                for (shift in 56 downTo 0 step 8) header.write(((payload.size.toLong() shr shift) and 0xFF).toInt())
            }
        }
        val body = if (maskKey != null) {
            header.write(maskKey)
            ByteArray(payload.size) { i -> (payload[i].toInt() xor maskKey[i and 3].toInt()).toByte() }
        } else payload
        // One write, so a frame is never interleaved with another on the wire.
        out.write(header.toByteArray() + body)
        out.flush()
    }

    fun closePayload(code: Int, reason: String = ""): ByteArray {
        val r = reason.toByteArray(Charsets.UTF_8).take(100).toByteArray()
        return byteArrayOf((code shr 8).toByte(), (code and 0xFF).toByte()) + r
    }

    // ---- base64 without android.util or java.util.Base64 (minSdk 24, and plain-JVM unit tests) ----

    private const val B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

    fun base64(bytes: ByteArray): String {
        val sb = StringBuilder((bytes.size + 2) / 3 * 4)
        var i = 0
        while (i < bytes.size) {
            val b0 = bytes[i].toInt() and 0xFF
            val b1 = if (i + 1 < bytes.size) bytes[i + 1].toInt() and 0xFF else 0
            val b2 = if (i + 2 < bytes.size) bytes[i + 2].toInt() and 0xFF else 0
            sb.append(B64[b0 shr 2])
            sb.append(B64[((b0 and 3) shl 4) or (b1 shr 4)])
            sb.append(if (i + 1 < bytes.size) B64[((b1 and 15) shl 2) or (b2 shr 6)] else '=')
            sb.append(if (i + 2 < bytes.size) B64[b2 and 63] else '=')
            i += 3
        }
        return sb.toString()
    }

    fun base64Decode(text: String): ByteArray? {
        if (text.length % 4 != 0) return null
        val out = ByteArrayOutputStream()
        var i = 0
        while (i < text.length) {
            val chunk = text.substring(i, i + 4)
            val pad = chunk.count { it == '=' }
            if (pad > 2 || chunk.substring(0, 4 - pad).contains('=')) return null
            var acc = 0
            for (c in chunk) {
                val v = if (c == '=') 0 else B64.indexOf(c)
                if (v < 0) return null
                acc = (acc shl 6) or v
            }
            out.write((acc shr 16) and 0xFF)
            if (pad < 2) out.write((acc shr 8) and 0xFF)
            if (pad < 1) out.write(acc and 0xFF)
            i += 4
        }
        return out.toByteArray()
    }
}
