package com.beeboentertainment.movie.campsite

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.sin
import org.junit.Test

/**
 * Opt-in fixture for checking synced music in a REAL browser (no phone, no APK): set
 * BEEBO_MUSIC_FIXTURE to an empty folder. The test starts a real CampsiteServer with two generated
 * WAV tracks, writes fixture-port.txt, then obeys one-line commands dropped into cmd.txt:
 *   load | play | pause | next | prev | seek <ms> | stop | role <name> <everyone|left|right> | status | done
 * `status` writes status.json. Without the environment variable it does nothing.
 */
class CampsiteMusicBrowserFixtureTest {
    private fun wav(seconds: Int, leftHz: Double, rightHz: Double): ByteArray {
        val rate = 44100
        val frames = seconds * rate
        val pcm = ByteBuffer.allocate(frames * 4).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until frames) {
            // a click every second so alignment is audible/visible, over two steady tones
            val click = if (i % rate < 200) 0.6 else 0.0
            pcm.putShort(((sin(2 * PI * leftHz * i / rate) * 0.25 + click) * 32000).toInt().coerceIn(-32768, 32767).toShort())
            pcm.putShort(((sin(2 * PI * rightHz * i / rate) * 0.25 + click) * 32000).toInt().coerceIn(-32768, 32767).toShort())
        }
        val out = ByteArrayOutputStream()
        val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        h.put("RIFF".toByteArray()).putInt(36 + pcm.capacity()).put("WAVEfmt ".toByteArray()).putInt(16).putShort(1).putShort(2)
            .putInt(rate).putInt(rate * 4).putShort(4).putShort(16).put("data".toByteArray()).putInt(pcm.capacity())
        out.write(h.array()); out.write(pcm.array())
        return out.toByteArray()
    }

    @Test fun musicBrowserFixture() {
        val folder = System.getenv("BEEBO_MUSIC_FIXTURE")?.let { File(it) } ?: return
        folder.mkdirs()
        val files = mapOf(
            "trackone" to File(folder, "trackone.wav").also { it.writeBytes(wav(30, 440.0, 660.0)) },
            "tracktwo" to File(folder, "tracktwo.wav").also { it.writeBytes(wav(25, 550.0, 770.0)) },
        )
        val script = File("src/main/assets/campsite-music.js").readText()
        val server = CampsiteServer(0, { emptyList() }, { null }, musicTrackFile = { files[it] }, musicScript = { script })
        val tracks = listOf(MusicTrackInfo("trackone", "Two Tones", "Fixture", "Test", 30_000), MusicTrackInfo("tracktwo", "Higher Tones", "Fixture", "Test", 25_000))
        try {
            server.start()
            File(folder, "fixture-port.txt").writeText(server.boundPort.toString())
            val cmd = File(folder, "cmd.txt")
            val until = System.currentTimeMillis() + 25 * 60_000
            while (System.currentTimeMillis() < until) {
                Thread.sleep(150)
                if (!cmd.exists()) continue
                val line = runCatching { cmd.readText().trim() }.getOrDefault("")
                cmd.delete()
                val p = line.split(" ")
                val m = server.music
                when (p[0]) {
                    "load" -> m.load(tracks)
                    "play" -> m.play()
                    "pause" -> m.pause()
                    "next" -> m.next()
                    "prev" -> m.previous()
                    "seek" -> m.seek(p[1].toLong())
                    "stop" -> m.stopMusic()
                    "role" -> m.guests().firstOrNull { it.name.contains(p[1], true) }?.let { m.setRole(it.id, MusicRole.parse(p[2]) ?: MusicRole.EVERYONE) }
                    "status" -> {
                        val s = m.engine.summary()
                        val guests = m.guests().joinToString(",") { g ->
                            """{"name":"${g.name}","role":"${g.role.wire}","unlocked":${g.unlocked},"ready":${g.ready},"state":"${g.state}","errMs":${if (g.errorMs.isFinite()) g.errorMs else -1},"driftMs":${g.driftMs},"rttMs":${g.rttMs},"inSync":${g.inSync}}"""
                        }
                        File(folder, "status.json").writeText("""{"state":"${s.state.wire}","index":${s.index},"positionMs":${s.positionMs},"guests":[$guests]}""")
                    }
                    "done" -> return
                }
            }
        } finally { server.stop() }
    }
}
