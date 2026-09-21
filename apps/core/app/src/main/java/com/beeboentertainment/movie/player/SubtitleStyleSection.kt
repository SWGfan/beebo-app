package com.beeboentertainment.movie.player

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.SubtitleView

/**
 * The "Subtitle style" block of the Quality & audio sheet: a live sample, the "Use system style"
 * switch and one row of choices per setting. Changing anything shows in the sample at once.
 * Picking a value while the system style is on turns it off, because the viewer is asking for
 * their own look.
 */
@UnstableApi
class SubtitleStyleSection(
    private var useSystem: Boolean,
    private var style: SubtitleStyle,
    /** Called after every change with the new state and the patch to save on the computer (null when nothing there changed). */
    private val onChange: (useSystem: Boolean, style: SubtitleStyle, patch: SubtitleStyle?, leftSystemMode: Boolean) -> Unit
) : SheetExtra {

    private lateinit var preview: SubtitleView
    private lateinit var systemSwitch: Switch
    private val refreshers = mutableListOf<() -> Unit>()

    override fun addTo(sheet: SheetContext) {
        val ctx = sheet.context
        PlaybackSheet.addHeader(sheet, "Subtitle style")

        preview = SubtitleView(ctx)
        val box = FrameLayout(ctx).apply {
            setBackgroundColor(Color.parseColor("#2B3A4E"))
            addView(preview, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            contentDescription = "Sample subtitle: ${SubtitleStyle.SAMPLE_TEXT}"
        }
        sheet.list.addView(box, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, sheet.dp(120)).apply {
            setMargins(sheet.dp(12), sheet.dp(4), sheet.dp(12), sheet.dp(8))
        })
        preview.setCues(listOf(Cue.Builder().setText(SubtitleStyle.SAMPLE_TEXT).build()))

        systemSwitch = Switch(ctx).apply {
            text = "Use system style"
            isChecked = useSystem
            setPadding(sheet.dp(12), sheet.dp(6), sheet.dp(12), sheet.dp(6))
            setOnCheckedChangeListener { _, checked -> onSwitch(checked) }
        }
        sheet.list.addView(systemSwitch)
        sheet.list.addView(TextView(ctx).apply {
            text = "On: follows this device's caption settings. Off: uses the look saved on your computer."
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            alpha = 0.7f
            setPadding(sheet.dp(12), 0, sheet.dp(12), sheet.dp(6))
        })

        chipRow(sheet, "Size", SubtitleStyleSteps.SIZES.map { Choice("$it%", it) }, { style.size }) { style.copy(size = it) }
        chipRow(sheet, "Text colour", SubtitleStyleSteps.TEXT_COLORS.map { Choice(it.first, it.second, swatch = it.second) }, { style.color }) { style.copy(color = it) }
        chipRow(sheet, "Background", SubtitleStyleSteps.BG_COLORS.map { Choice(it.first, it.second, swatch = it.second) }, { style.bg }) { style.copy(bg = it) }
        chipRow(sheet, "Background opacity", SubtitleStyleSteps.OPACITIES.map { Choice("$it%", it) }, { style.bgOpacity }) { style.copy(bgOpacity = it) }
        chipRow(sheet, "Edge", SubtitleEdge.entries.map { Choice(it.label, it) }, { style.edge }) { style.copy(edge = it) }
        chipRow(sheet, "Position from the bottom", SubtitleStyleSteps.POSITIONS.map { Choice("$it%", it) }, { style.position }) { style.copy(position = it) }
        chipRow(sheet, "Font", SubtitleFont.entries.map { Choice(it.label, it) }, { style.font }) { style.copy(font = it) }

        render()
    }

    private class Choice<T>(val label: String, val value: T, val swatch: String? = null)

    private fun <T> chipRow(sheet: SheetContext, title: String, choices: List<Choice<T>>, current: () -> T, make: (T) -> SubtitleStyle) {
        val ctx = sheet.context
        sheet.list.addView(TextView(ctx).apply {
            text = title
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(sheet.dp(12), sheet.dp(8), sheet.dp(12), sheet.dp(2))
        })
        val strip = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(sheet.dp(8), sheet.dp(2), sheet.dp(8), sheet.dp(2))
        }
        val marks = mutableListOf<Pair<Choice<T>, View>>()
        for (choice in choices) {
            val chip = TextView(ctx).apply {
                text = if (choice.swatch != null) "" else choice.label
                contentDescription = choice.label
                gravity = Gravity.CENTER
                isFocusable = true
                isClickable = true
                setTextSize(TypedValue.COMPLEX_UNIT_SP, if (sheet.isTv) 16f else 14f)
                minWidth = sheet.dp(if (choice.swatch != null) 40 else 48)
                minHeight = sheet.dp(if (sheet.isTv) 44 else 40)
                setPadding(sheet.dp(12), sheet.dp(4), sheet.dp(12), sheet.dp(4))
                if (choice.swatch != null) setTextColor(Color.TRANSPARENT)
                setOnClickListener {
                    val leftSystem = useSystem
                    useSystem = false
                    systemSwitch.setOnCheckedChangeListener(null)
                    systemSwitch.isChecked = false
                    systemSwitch.setOnCheckedChangeListener { _, checked -> onSwitch(checked) }
                    changed(make(choice.value), leftSystem)
                }
            }
            strip.addView(chip, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                setMargins(sheet.dp(3), 0, sheet.dp(3), 0)
            })
            marks += choice to chip
        }
        val scroller = HorizontalScrollView(ctx).apply {
            isHorizontalScrollBarEnabled = false
            addView(strip)
        }
        sheet.list.addView(scroller)
        refreshers += {
            for ((choice, chip) in marks) {
                val selected = !useSystem && choice.value == current()
                chip.background = chipBackground(choice.swatch, selected, sheet)
                chip.alpha = if (useSystem) 0.55f else 1f
                (chip as TextView).setTypeface(null, if (selected) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
            }
        }
    }

    private fun onSwitch(checked: Boolean) {
        if (checked == useSystem) return
        val left = useSystem && !checked
        useSystem = checked
        changed(null, left)
    }

    private fun chipBackground(swatch: String?, selected: Boolean, sheet: SheetContext): GradientDrawable =
        GradientDrawable().apply {
            shape = if (swatch != null) GradientDrawable.OVAL else GradientDrawable.RECTANGLE
            cornerRadius = sheet.dp(16).toFloat()
            setColor(if (swatch != null) Color.parseColor(swatch) else Color.parseColor("#22FFFFFF"))
            setStroke(sheet.dp(if (selected) 3 else 1), Color.parseColor(if (selected) "#4FC3F7" else "#55FFFFFF"))
        }

    private fun changed(newStyle: SubtitleStyle?, leftSystemMode: Boolean) {
        val before = style
        if (newStyle != null) style = newStyle
        render()
        onChange(useSystem, style, if (newStyle != null && newStyle != before) style else null, leftSystemMode)
    }

    private fun render() {
        SubtitleStyleApplier.apply(preview, useSystem, style, preview = true)
        refreshers.forEach { it() }
    }
}
