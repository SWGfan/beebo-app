package com.beeboentertainment.movie.player

import android.content.SharedPreferences
import android.graphics.Color
import android.graphics.Typeface
import android.util.TypedValue
import android.view.accessibility.CaptioningManager
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.SubtitleView

/**
 * This device's own subtitle settings: whether to follow the system's caption settings (the
 * default), and a copy of the account's saved look so it is right before the computer answers.
 */
class SubtitleStyleStore(private val prefs: SharedPreferences) {
    var useSystem: Boolean
        get() = prefs.getBoolean(PREF_USE_SYSTEM, true)
        set(v) { prefs.edit().putBoolean(PREF_USE_SYSTEM, v).apply() }

    var style: SubtitleStyle
        get() = SubtitleStyle.parseStored(prefs.getString(PREF_STYLE, null)) ?: SubtitleStyle()
        set(v) { prefs.edit().putString(PREF_STYLE, v.toJson().toString()).apply() }

    /** True once a look has been saved here, so applying it before the computer answers is worthwhile. */
    val hasStyle: Boolean get() = prefs.contains(PREF_STYLE)

    companion object {
        const val PREF_USE_SYSTEM = "subtitle_use_system_style"
        const val PREF_STYLE = "subtitle_style_json"
    }
}

/** Puts a subtitle look on a Media3 [SubtitleView]: the real one over the film, or the sample in the menu. */
@UnstableApi
object SubtitleStyleApplier {

    /**
     * [preview] is the small sample box in the menu. Its text is sized in sp rather than as a fraction
     * of a box that is far smaller than a screen, or the sample would be unreadably tiny.
     */
    fun apply(view: SubtitleView, useSystem: Boolean, style: SubtitleStyle, preview: Boolean = false) {
        if (useSystem) {
            view.setApplyEmbeddedStyles(true)
            view.setApplyEmbeddedFontSizes(true)
            view.setUserDefaultStyle()
            view.setBottomPaddingFraction(SubtitleView.DEFAULT_BOTTOM_PADDING_FRACTION)
            if (preview) {
                view.setFixedTextSize(TypedValue.COMPLEX_UNIT_SP, PREVIEW_SP * systemFontScale(view))
            } else {
                view.setUserDefaultTextSize()
            }
            return
        }
        // The viewer's own choice must beat a style a subtitle file carries.
        view.setApplyEmbeddedStyles(false)
        view.setApplyEmbeddedFontSizes(false)
        view.setStyle(captionStyle(style))
        view.setBottomPaddingFraction(SubtitleStyleMath.bottomPaddingFraction(style.position))
        if (preview) {
            view.setFixedTextSize(TypedValue.COMPLEX_UNIT_SP, PREVIEW_SP * style.size / 100f)
        } else {
            view.setFractionalTextSize(SubtitleStyleMath.textFraction(style.size))
        }
    }

    fun captionStyle(style: SubtitleStyle): CaptionStyleCompat {
        val foreground = SubtitleStyleMath.foregroundArgb(style.color)
        val edgeType = when (style.edge) {
            SubtitleEdge.NONE -> CaptionStyleCompat.EDGE_TYPE_NONE
            SubtitleEdge.OUTLINE -> CaptionStyleCompat.EDGE_TYPE_OUTLINE
            SubtitleEdge.SHADOW -> CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW
            SubtitleEdge.RAISED -> CaptionStyleCompat.EDGE_TYPE_RAISED
            SubtitleEdge.DEPRESSED -> CaptionStyleCompat.EDGE_TYPE_DEPRESSED
        }
        return CaptionStyleCompat(
            foreground,
            SubtitleStyleMath.backgroundArgb(style.bg, style.bgOpacity),
            Color.TRANSPARENT,
            edgeType,
            SubtitleStyleMath.edgeArgb(style.color),
            style.font.family?.let { Typeface.create(it, Typeface.NORMAL) }
        )
    }

    private fun systemFontScale(view: SubtitleView): Float =
        (view.context.getSystemService(android.content.Context.CAPTIONING_SERVICE) as? CaptioningManager)
            ?.fontScale?.takeIf { it > 0f } ?: 1f

    private const val PREVIEW_SP = 18f
}
