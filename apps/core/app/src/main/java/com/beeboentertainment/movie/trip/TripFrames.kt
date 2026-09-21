package com.beeboentertainment.movie.trip

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.media.ExifInterface
import android.net.Uri
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import java.io.File
import java.io.FileOutputStream

/** Sizing sums for drawing a photo into a video frame. Pure, so the arithmetic is tested. */
internal object FrameMath {

    data class Fit(val left: Float, val top: Float, val width: Float, val height: Float)

    /** The largest [srcW] x [srcH] picture that fits inside [dstW] x [dstH] without cropping, centred. */
    fun fit(srcW: Int, srcH: Int, dstW: Int, dstH: Int): Fit {
        if (srcW <= 0 || srcH <= 0) return Fit(0f, 0f, dstW.toFloat(), dstH.toFloat())
        val scale = minOf(dstW.toFloat() / srcW, dstH.toFloat() / srcH)
        val w = srcW * scale
        val h = srcH * scale
        return Fit((dstW - w) / 2f, (dstH - h) / 2f, w, h)
    }

    /**
     * How much to shrink a photo while decoding it: the biggest power of two that still leaves it at
     * least as large as the frame in both directions. A 48-megapixel photo would otherwise be decoded
     * in full just to be drawn into a 2-megapixel frame.
     */
    fun sampleSize(srcW: Int, srcH: Int, dstW: Int, dstH: Int): Int {
        if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return 1
        var sample = 1
        while (srcW / (sample * 2) >= dstW && srcH / (sample * 2) >= dstH) sample *= 2
        return sample
    }
}

/**
 * Draws the pictures that go into the exported video: the cards, and each photo fitted into a
 * frame of exactly the output size.
 *
 * A photo is decoded from pixels and drawn onto a new bitmap, then saved as a fresh JPEG. That
 * fresh file has none of the original's metadata (EXIF, GPS position, camera and time), which is
 * how the export keeps location out of photos without depending on any library option. It also
 * applies the photo's orientation and keeps memory bounded.
 */
internal object TripFrames {

    private val Ground = Color.parseColor("#0B0F14")
    private val Ink = Color.WHITE
    private val InkSoft = Color.parseColor("#C3CCD6")
    private val Accent = Color.parseColor("#F2B84B")

    /** A card drawn at [width] x [height], in the same look as Present mode. */
    fun card(slide: Slide, width: Int, height: Int): Bitmap {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Ground)
        val cover = slide.kind == SlideKind.COVER
        val align = if (cover) Layout.Alignment.ALIGN_CENTER else Layout.Alignment.ALIGN_NORMAL
        val margin = (width * 0.08f).toInt()
        val textWidth = width - margin * 2

        // Shrink the type in steps until the whole card fits, so a long story never runs off the frame.
        var scale = height / 1080f
        var blocks = layoutBlocks(slide, textWidth, scale, align, cover)
        var attempts = 0
        while (blocks.sumOf { it.height + it.gapBefore } > height - margin && attempts++ < 10) {
            scale *= 0.9f
            blocks = layoutBlocks(slide, textWidth, scale, align, cover)
        }
        var y = (height - blocks.sumOf { it.height + it.gapBefore }) / 2f
        val bullet = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Accent }
        blocks.forEach { block ->
            y += block.gapBefore
            canvas.save()
            canvas.translate(margin.toFloat(), y)
            if (block.bullet) {
                val size = 9f * scale * 1.6f
                canvas.drawRect(0f, 22f * scale * 1.6f, size, 22f * scale * 1.6f + size, bullet)
                canvas.translate(size + 22f * scale, 0f)
            }
            block.layout.draw(canvas)
            canvas.restore()
            y += block.height
        }
        return bitmap
    }

    private class Block(val layout: StaticLayout, val gapBefore: Int, val bullet: Boolean) {
        val height: Int get() = layout.height
    }

    private fun layoutBlocks(slide: Slide, textWidth: Int, s: Float, align: Layout.Alignment, cover: Boolean): List<Block> {
        val blocks = mutableListOf<Block>()
        fun add(text: String, size: Float, color: Int, bold: Boolean, gap: Float, bullet: Boolean = false, alignment: Layout.Alignment = align) {
            if (text.isBlank()) return
            val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
                this.color = color
                textSize = size * s * 1.6f
                typeface = Typeface.create(Typeface.DEFAULT, if (bold) Typeface.BOLD else Typeface.NORMAL)
            }
            val width = if (bullet) textWidth - (9f * s * 1.6f + 22f * s).toInt() else textWidth
            val layout = StaticLayout.Builder.obtain(text, 0, text.length, paint, width.coerceAtLeast(1))
                .setAlignment(alignment)
                .setLineSpacing(0f, 1.15f)
                .setEllipsize(TextUtils.TruncateAt.END)
                .setMaxLines(if (bullet) 3 else 12)
                .build()
            blocks += Block(layout, (gap * s * 1.6f).toInt(), bullet)
        }
        add(slide.title, if (cover) 64f else 46f, Ink, bold = true, gap = 0f)
        add(slide.subtitle, 28f, Accent, bold = false, gap = 10f)
        add(slide.body, 32f, Ink, bold = false, gap = 26f)
        slide.lines.forEachIndexed { i, line ->
            if (cover) add(line, 30f, InkSoft, bold = false, gap = if (i == 0) 22f else 8f)
            else add(line, 32f, Ink, bold = false, gap = if (i == 0) 28f else 14f, bullet = true)
        }
        return blocks
    }

    /**
     * A photo fitted inside a black frame of [width] x [height], or null if it cannot be opened or
     * decoded (the picker's access can lapse), in which case the caller leaves it out.
     */
    fun photo(context: Context, uri: Uri, width: Int, height: Int): Bitmap? = runCatching {
        val resolver = context.contentResolver
        val orientation = resolver.openInputStream(uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
            ?: ExifInterface.ORIENTATION_NORMAL
        val matrix = orientationMatrix(orientation)
        val swapped = orientation in setOf(
            ExifInterface.ORIENTATION_ROTATE_90, ExifInterface.ORIENTATION_ROTATE_270,
            ExifInterface.ORIENTATION_TRANSPOSE, ExifInterface.ORIENTATION_TRANSVERSE,
        )

        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@runCatching null
        val srcW = if (swapped) bounds.outHeight else bounds.outWidth
        val srcH = if (swapped) bounds.outWidth else bounds.outHeight

        val opts = BitmapFactory.Options().apply { inSampleSize = FrameMath.sampleSize(srcW, srcH, width, height) }
        val decoded = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
            ?: return@runCatching null
        val upright = if (matrix.isIdentity) decoded
        else Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true).also { if (it !== decoded) decoded.recycle() }

        val frame = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(frame)
        canvas.drawColor(Color.BLACK)
        val fit = FrameMath.fit(upright.width, upright.height, width, height)
        canvas.drawBitmap(upright, null, RectF(fit.left, fit.top, fit.left + fit.width, fit.top + fit.height), Paint(Paint.FILTER_BITMAP_FLAG))
        upright.recycle()
        frame
    }.getOrNull()

    private fun orientationMatrix(orientation: Int): Matrix = Matrix().apply {
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> postScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> postRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { postRotate(90f); postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90 -> postRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> { postRotate(-90f); postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> postRotate(-90f)
        }
    }

    fun save(bitmap: Bitmap, file: File, png: Boolean) {
        FileOutputStream(file).use { out ->
            if (png) bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            else bitmap.compress(Bitmap.CompressFormat.JPEG, 92, out)
        }
    }
}
