package com.beeboentertainment.movie.tripshare

/**
 * The arithmetic behind redrawing a photo smaller before it leaves the phone, with no Android in it.
 * The redraw is what removes every trace of the original's metadata: the new JPEG is written from
 * decoded pixels only, so it carries no Exif, no GPS, no camera details.
 */
internal object TripSharePhotoMath {

    /** A power of two to hand to a decoder so it reads no more than about twice [maxEdge] on the long side. */
    fun sampleSize(width: Int, height: Int, maxEdge: Int): Int {
        if (width <= 0 || height <= 0 || maxEdge <= 0) return 1
        var sample = 1
        var longest = maxOf(width, height)
        while (longest / 2 >= maxEdge) { sample *= 2; longest /= 2 }
        return sample
    }

    /** Width and height scaled down (never up) so the long side is at most [maxEdge]. */
    fun scaledSize(width: Int, height: Int, maxEdge: Int): Pair<Int, Int> {
        val longest = maxOf(width, height)
        if (longest <= maxEdge || longest <= 0) return width to height
        val f = maxEdge.toDouble() / longest
        return maxOf(1, Math.round(width * f).toInt()) to maxOf(1, Math.round(height * f).toInt())
    }

    /** How to turn a picture upright for an Exif orientation value (1..8): rotate by [degrees] clockwise, then mirror left-right if [flipHorizontal]. */
    data class Upright(val degrees: Int, val flipHorizontal: Boolean)

    fun upright(exifOrientation: Int): Upright = when (exifOrientation) {
        2 -> Upright(0, true)
        3 -> Upright(180, false)
        4 -> Upright(180, true)
        5 -> Upright(90, true)
        6 -> Upright(90, false)
        7 -> Upright(270, true)
        8 -> Upright(270, false)
        else -> Upright(0, false)
    }

    /** Width and height after turning upright: a quarter turn swaps them. */
    fun uprightSize(width: Int, height: Int, u: Upright): Pair<Int, Int> =
        if (u.degrees == 90 || u.degrees == 270) height to width else width to height
}
