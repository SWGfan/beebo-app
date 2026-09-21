package com.beeboentertainment.movie.player

import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.beeboentertainment.movie.core.PlaybackSheetModel

/** What a section added by the player itself (subtitle style, versions) gets to build into. */
class SheetContext(
    val context: Context,
    val isTv: Boolean,
    val list: LinearLayout,
    val dismiss: () -> Unit
) {
    fun dp(v: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), context.resources.displayMetrics).toInt()
}

/** A block of views appended after the standard sections. It stays inside the menu; taps do not close it unless it says so. */
fun interface SheetExtra {
    fun addTo(sheet: SheetContext)
}

/**
 * The "Quality, audio & subtitles" sheet. Plain views in a dialog so a TV remote moves through it
 * with the D-pad (every row is focusable, the current quality takes focus first) and a phone taps it.
 */
object PlaybackSheet {

    fun show(
        context: Context,
        sections: List<PlaybackSheetModel.Section>,
        isTv: Boolean,
        extras: List<SheetExtra> = emptyList(),
        onRow: (PlaybackSheetModel.Row) -> Unit
    ): AlertDialog {
        val list = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dpOf(context, 8), dpOf(context, 4), dpOf(context, 8), dpOf(context, 12))
        }
        var dialog: AlertDialog? = null
        var firstFocus: View? = null
        val sheet = SheetContext(context, isTv, list) { dialog?.dismiss() }

        for (section in sections) {
            addHeader(sheet, section.title)
            for (row in section.rows) {
                val info = row.action == PlaybackSheetModel.Action.INFO
                val item = addChoiceRow(
                    sheet, row.label, row.detail, row.selected, row.enabled, info
                ) {
                    dialog?.dismiss()
                    onRow(row)
                }
                if (firstFocus == null && row.selected && section == sections.first()) firstFocus = item
            }
        }
        for (extra in extras) extra.addTo(sheet)

        dialog = AlertDialog.Builder(context)
            .setTitle("Quality, audio & subtitles")
            .setView(ScrollView(context).apply { addView(list) })
            .setNegativeButton("Close", null)
            .create()
        dialog.setOnShowListener { (firstFocus ?: list.getChildAt(1))?.requestFocus() }
        dialog.show()
        return dialog
    }

    fun addHeader(sheet: SheetContext, title: String): TextView {
        val header = TextView(sheet.context).apply {
            text = title.uppercase()
            setTypeface(typeface, Typeface.BOLD)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            alpha = 0.7f
            setPadding(sheet.dp(12), sheet.dp(14), sheet.dp(12), sheet.dp(4))
        }
        sheet.list.addView(header)
        return header
    }

    /** One focusable row: a dot when selected, a label and a smaller line under it. */
    fun addChoiceRow(
        sheet: SheetContext,
        label: String,
        detail: String,
        selected: Boolean,
        enabled: Boolean = true,
        infoOnly: Boolean = false,
        onClick: () -> Unit
    ): View {
        val context = sheet.context
        val rowBackground = TypedValue().also { context.theme.resolveAttribute(android.R.attr.selectableItemBackground, it, true) }.resourceId
        val item = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            isFocusable = true
            isClickable = enabled
            alpha = if (enabled || infoOnly) 1f else 0.45f
            minimumHeight = sheet.dp(if (sheet.isTv) 52 else 46)
            setPadding(sheet.dp(12), sheet.dp(6), sheet.dp(12), sheet.dp(6))
            if (rowBackground != 0) setBackgroundResource(rowBackground)
            contentDescription = buildString {
                append(label)
                if (detail.isNotBlank()) append(", ").append(detail)
                if (selected) append(", selected")
                if (!enabled && !infoOnly) append(", not available")
            }
            setOnClickListener {
                if (!enabled) return@setOnClickListener
                onClick()
            }
        }
        item.addView(TextView(context).apply {
            text = if (selected) "●" else ""
            setTextColor(Color.parseColor("#4FC3F7"))
            width = sheet.dp(24)
        })
        val texts = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(TextView(context).apply {
            text = label
            setTextSize(TypedValue.COMPLEX_UNIT_SP, if (sheet.isTv) 18f else 16f)
            if (selected) setTypeface(typeface, Typeface.BOLD)
        })
        if (detail.isNotBlank()) texts.addView(TextView(context).apply {
            text = detail
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            alpha = 0.7f
        })
        item.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        sheet.list.addView(item, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        return item
    }

    private fun dpOf(context: Context, v: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), context.resources.displayMetrics).toInt()
}
