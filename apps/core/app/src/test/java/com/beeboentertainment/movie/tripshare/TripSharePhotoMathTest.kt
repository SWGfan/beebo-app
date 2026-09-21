package com.beeboentertainment.movie.tripshare

import org.junit.Assert.assertEquals
import org.junit.Test

class TripSharePhotoMathTest {

    @Test
    fun `sample size halves until the long side is near the target and never below one`() {
        assertEquals(1, TripSharePhotoMath.sampleSize(1200, 800, 1600))
        assertEquals(1, TripSharePhotoMath.sampleSize(3000, 2000, 1600))
        assertEquals(2, TripSharePhotoMath.sampleSize(4000, 3000, 1600))
        assertEquals(4, TripSharePhotoMath.sampleSize(8000, 6000, 1600))
        assertEquals(1, TripSharePhotoMath.sampleSize(0, 0, 1600))
    }

    @Test
    fun `scaling keeps the aspect ratio, only shrinks, and fits the long side`() {
        assertEquals(1600 to 1200, TripSharePhotoMath.scaledSize(4000, 3000, 1600))
        assertEquals(1200 to 1600, TripSharePhotoMath.scaledSize(3000, 4000, 1600))
        assertEquals(800 to 600, TripSharePhotoMath.scaledSize(800, 600, 1600))
        assertEquals(1600 to 1, TripSharePhotoMath.scaledSize(100_000, 30, 1600))
    }

    @Test
    fun `every exif orientation turns the picture upright`() {
        assertEquals(TripSharePhotoMath.Upright(0, false), TripSharePhotoMath.upright(1))
        assertEquals(TripSharePhotoMath.Upright(90, false), TripSharePhotoMath.upright(6))
        assertEquals(TripSharePhotoMath.Upright(270, false), TripSharePhotoMath.upright(8))
        assertEquals(TripSharePhotoMath.Upright(180, false), TripSharePhotoMath.upright(3))
        assertEquals(TripSharePhotoMath.Upright(0, true), TripSharePhotoMath.upright(2))
        assertEquals(TripSharePhotoMath.Upright(90, true), TripSharePhotoMath.upright(5))
        assertEquals(TripSharePhotoMath.Upright(0, false), TripSharePhotoMath.upright(99))
    }

    @Test
    fun `a quarter turn swaps width and height`() {
        assertEquals(3000 to 4000, TripSharePhotoMath.uprightSize(4000, 3000, TripSharePhotoMath.upright(6)))
        assertEquals(4000 to 3000, TripSharePhotoMath.uprightSize(4000, 3000, TripSharePhotoMath.upright(3)))
    }
}
