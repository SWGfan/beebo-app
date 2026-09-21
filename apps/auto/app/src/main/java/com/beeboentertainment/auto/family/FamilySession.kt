package com.beeboentertainment.auto.family

import android.os.Bundle
import android.os.SystemClock
import androidx.media3.common.Player
import androidx.media3.session.CommandButton
import androidx.media3.session.SessionCommand
import com.beeboentertainment.auto.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * The sleep timer's link to the player, and the one extra button it puts on the car's now-playing
 * screen. The timer's rules are in [SleepTimerLogic]; this only applies them.
 *
 * The clock used is [SystemClock.elapsedRealtime]: it only ever moves forward, so a change of the
 * phone's time or time zone in the middle of a drive cannot stretch or cut the timer.
 */
internal object FamilySessionCommands {

    /** Cycles the sleep timer: off, 15, 30, 45 minutes, off. The car shows it as a custom action. */
    val SLEEP = SessionCommand("com.beeboentertainment.auto.family.SLEEP_TIMER", Bundle.EMPTY)

    fun now(): Long = SystemClock.elapsedRealtime()

    /** One press of the sleep button. */
    fun cycleSleep() {
        val minutes = SleepTimerLogic.nextChoice(FamilyRuntime.sleep.value, now())
        FamilyRuntime.sleep.value = minutes?.let { SleepTimerLogic.start(now(), it) }
    }

    /** The button, labelled with what pressing it will do next. Short words: it is shown in a car. */
    fun sleepButton(): CommandButton {
        val label = "Sleep timer: " + SleepTimerLogic.label(FamilyRuntime.sleep.value, now())
        return CommandButton.Builder(CommandButton.ICON_UNDEFINED)
            .setCustomIconResId(R.drawable.ic_sleep_timer)
            .setDisplayName(label)
            .setSessionCommand(SLEEP)
            .build()
    }
}

/** Applies the timer to the player: fade, then pause, then forget. Runs only while a timer is set. */
internal class FamilySleepController(
    private val player: Player,
    private val scope: CoroutineScope,
    private val onChanged: () -> Unit,
) {
    private var job: Job? = null
    private var volumeChanged = false

    fun start() {
        job?.cancel()
        job = scope.launch {
            FamilyRuntime.sleep.collectLatest { state ->
                if (state == null) {
                    restoreVolume()
                    onChanged()
                    return@collectLatest
                }
                onChanged()
                var ticks = 0
                while (isActive) {
                    // The car button's label ("20 min left") is refreshed about once a minute.
                    if (++ticks % LABEL_EVERY_TICKS == 0) onChanged()
                    val tick = SleepTimerLogic.tick(state, FamilySessionCommands.now())
                    if (tick.stop) {
                        // Time is up: stop for good, put the volume back for next time, forget the timer.
                        player.pause()
                        restoreVolume()
                        FamilyRuntime.sleep.value = null
                        break
                    }
                    if (tick.volume < 1f || volumeChanged) {
                        player.volume = tick.volume
                        volumeChanged = true
                    }
                    delay(TICK_MS)
                }
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        restoreVolume()
    }

    private fun restoreVolume() {
        if (volumeChanged) {
            player.volume = 1f
            volumeChanged = false
        }
    }

    private companion object {
        const val TICK_MS = 1_000L
        const val LABEL_EVERY_TICKS = 60
    }
}
