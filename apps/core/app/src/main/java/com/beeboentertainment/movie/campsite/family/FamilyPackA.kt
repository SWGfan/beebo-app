package com.beeboentertainment.movie.campsite.family

import com.beeboentertainment.movie.campsite.quiet.QuietGate
import com.beeboentertainment.movie.campsite.quiet.QuietHours
import com.beeboentertainment.movie.campsite.quiet.QuietView
import com.beeboentertainment.movie.campsite.tripclock.TripClockStore
import com.beeboentertainment.movie.campsite.tripclock.TripClockLogic
import com.beeboentertainment.movie.campsite.tripclock.TripClockView
import com.beeboentertainment.movie.data.SessionStore
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.TimeZone

/**
 * What the guests' browsers are told about Family Pack A: quiet hours (a banner on every page) and
 * the trip clock (a read-only "are we there yet" page). One small GET, `/api/family`, polled every
 * few seconds by the pages, so a change on the host reaches a guest within one poll (about 4 s).
 *
 * WHAT IS IN IT. Words and numbers the host phone already decided: "Quiet hours until 6:00 AM",
 * "about 3 episodes", a fraction along the road. No guest text goes in, so there is nothing to
 * escape on the way out; the host's own text (a stop's name) is JSON-encoded here and put on the page
 * with textContent there. No location is in it, ever: the clock's state has no coordinate field.
 *
 * The clock part is sent only to a phone that has joined the campsite; the quiet part is public
 * (a banner has to show on the landing page too).
 */
internal class FamilyPackA(
    private val quiet: (() -> QuietView)?,
    private val clock: (() -> TripClockView)?,
) {

    fun statusJson(joined: Boolean): String = buildJsonObject {
        put("ok", true)
        val q = quiet?.invoke()
        if (q == null) put("quiet", JsonNull) else put("quiet", buildJsonObject {
            put("enabled", q.enabled)
            put("active", q.active)
            put("headphones", q.headphones)
            put("endText", q.endText)
            put("banner", q.bannerText)
            put("warn", when {
                q.active || q.startsInMs < 0L || q.startsInMs > QuietHours.WARN_MS -> ""
                else -> "Quiet hours start in " + QuietHours.durationText(q.startsInMs) + ". Please start winding down."
            })
            put("note", "Check your campground's posted quiet hours.")
        })
        val c = if (joined) clock?.invoke() else null
        if (c == null || !c.running) put("clock", JsonNull) else put("clock", buildJsonObject {
            put("arrived", c.arrived)
            put("fraction", c.fraction)
            put("left", c.leftText)
            put("kid", c.kidText)
            put("eta", c.etaText)
            put("late", c.late)
            put("delayText", if (c.delayMs > 0L) "Running about " + WallClock.durationText(c.delayMs) + " later than first planned." else "")
            put("distance", c.distanceText)
            put("stops", JsonArray(c.stops.mapIndexed { i, stop ->
                buildJsonObject { put("title", stop.title); put("at", c.stopFractions.getOrElse(i) { 0.0 }) }
            }))
            put("disclaimer", TripClockView.DISCLAIMER)
            put("passengers", TripClockView.PASSENGERS)
        })
    }.toString()

    companion object {
        /** No family features (tests and previews with no session): a status with nothing in it. */
        val NONE = FamilyPackA(null, null)

        /** The real thing, on the app's own stores. Null [session] means [NONE]. */
        fun forSession(session: SessionStore?): FamilyPackA {
            if (session == null) return NONE
            val clockStore = TripClockStore(SharedPrefsFamilyStorage(session.plain))
            return FamilyPackA(
                quiet = { QuietGate.runtime.view() },
                clock = { TripClockLogic.view(clockStore.state(), System.currentTimeMillis(), TimeZone.getDefault()) },
            )
        }
    }
}

/**
 * The banner every guest page carries. It is a `<div>` after the opening body tag and a small script
 * before the closing one, both added by the server when it sends an HTML page (so the games page, the
 * library, music, slides and every later page get it with no edit).
 *
 * The script does exactly three things: polls `/api/family` about every 4 seconds while the page is
 * in view, writes the banner text with textContent (never innerHTML), and while quiet hours are on
 * makes the browser's own speech (the campfire story reader) stay silent. It sends nothing and stores
 * nothing.
 */
internal object FamilyBanner {

    const val DIV = """<div id="beebo-quiet" role="status" aria-live="polite" hidden style="position:sticky;top:0;z-index:2147483000;padding:10px 14px;background:#2a2150;color:#fff;border-bottom:2px solid #efcc69;font:600 14px/1.35 system-ui,sans-serif;text-align:center"></div>"""

    val SCRIPT = """<script>(function(){var box=document.getElementById('beebo-quiet');if(!box)return;window.__beeboQuiet=false;
try{if(window.speechSynthesis&&!window.__beeboSpeechPatched){var real=speechSynthesis.speak.bind(speechSynthesis);speechSynthesis.speak=function(u){if(window.__beeboQuiet)return;return real(u);};window.__beeboSpeechPatched=true;}}catch(e){}
function apply(q){if(!q||!(q.active||q.warn)){box.hidden=true;box.textContent='';window.__beeboQuiet=false;return;}
window.__beeboQuiet=!!q.active;box.textContent=q.active?q.banner:q.warn;box.hidden=false;
if(q.active){try{if(window.speechSynthesis)speechSynthesis.cancel();}catch(e){}}}
var busy=false;function poll(){if(busy||document.hidden)return;busy=true;
fetch('/api/family',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(j){apply(j&&j.quiet);}).catch(function(){}).then(function(){busy=false;});}
poll();setInterval(poll,4000);document.addEventListener('visibilitychange',poll);})();</script>"""

    private val BODY_OPEN = Regex("<body[^>]*>", RegexOption.IGNORE_CASE)

    /** Put the banner into [html]. Pages that are not HTML documents pass through untouched. */
    fun inject(html: String): String {
        if (html.contains("id=\"beebo-quiet\"")) return html
        val open = BODY_OPEN.find(html) ?: return html
        val close = html.lastIndexOf("</body>", ignoreCase = true)
        val withDiv = html.substring(0, open.range.last + 1) + DIV + html.substring(open.range.last + 1)
        val at = if (close >= 0) close + DIV.length else -1
        return if (at >= 0) withDiv.substring(0, at) + SCRIPT + withDiv.substring(at) else withDiv + SCRIPT
    }
}
