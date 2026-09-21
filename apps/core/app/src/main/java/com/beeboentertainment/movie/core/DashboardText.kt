package com.beeboentertainment.movie.core

/** Plain-English numbers for the admin Dashboard tab. Pure, so it is unit tested. */
object DashboardText {
    fun bitrate(bitsPerSec: Long): String = when {
        bitsPerSec <= 0 -> "0 Mbps"
        bitsPerSec < 1_000_000 -> "${bitsPerSec / 1000} kbps"
        else -> String.format(java.util.Locale.US, "%.1f Mbps", bitsPerSec / 1_000_000.0)
    }

    fun duration(seconds: Long): String {
        val s = seconds.coerceAtLeast(0)
        val h = s / 3600
        val m = (s % 3600) / 60
        return when {
            h >= 24 -> "${h / 24}d ${h % 24}h"
            h > 0 -> "${h}h ${m}m"
            else -> "${m}m"
        }
    }

    fun clock(seconds: Double): String {
        val s = seconds.toLong().coerceAtLeast(0)
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = (s % 60).toString().padStart(2, '0')
        return if (h > 0) "$h:${m.toString().padStart(2, '0')}:$sec" else "$m:$sec"
    }

    fun ago(epochMs: Long?, now: Long = System.currentTimeMillis()): String {
        if (epochMs == null || epochMs <= 0) return "never"
        val d = (now - epochMs).coerceAtLeast(0)
        return when {
            d < 60_000 -> "just now"
            d < 3_600_000 -> "${d / 60_000} min ago"
            d < 86_400_000 -> "${d / 3_600_000} h ago"
            else -> "${d / 86_400_000} days ago"
        }
    }

    fun whereIcon(where: String): String = when (where) {
        "home" -> "🏠"
        "away_direct" -> "🌍"
        "away_relay" -> "🛰️"
        "cast" -> "📺"
        else -> ""
    }
}
