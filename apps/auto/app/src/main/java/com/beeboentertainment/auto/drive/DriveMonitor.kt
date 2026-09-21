package com.beeboentertainment.auto.drive

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.car.app.connection.CarConnection
import androidx.lifecycle.Observer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Collects the live signals [VideoGate] decides on, for one Activity.
 *
 *  - On Android Automotive OS: the car's UX restrictions ([CarUxWatcher]).
 *  - On a phone: whether it is projecting to Android Auto, from the Car App
 *    Library's [CarConnection] (CONNECTION_TYPE_PROJECTION).
 *  - Everywhere: the per-session "I'm a passenger" confirmation.
 *
 * Call [start] in onStart and [stop] in onStop, on the main thread.
 */
class DriveMonitor(context: Context) {

    private val app = context.applicationContext

    val isAutomotive: Boolean =
        app.packageManager.hasSystemFeature(PackageManager.FEATURE_AUTOMOTIVE)

    private val _signals = MutableStateFlow(VideoGate.Signals(isAutomotive = isAutomotive))
    val signals: StateFlow<VideoGate.Signals> = _signals.asStateFlow()

    private var carUx: CarUxWatcher? = null
    private var carUxCollector: Job? = null
    private var connection: CarConnection? = null

    private val connectionObserver = Observer<Int> { type ->
        _signals.update {
            it.copy(projectingToAndroidAuto = type == CarConnection.CONNECTION_TYPE_PROJECTION)
        }
    }

    fun start(scope: CoroutineScope) {
        if (isAutomotive) {
            if (carUx == null) {
                val w = CarUxWatcher(app).also { carUx = it }
                w.start()
                carUxCollector = scope.launch {
                    w.requiresDistractionOptimization.collect { v ->
                        _signals.update { it.copy(carRequiresDistractionOptimization = v) }
                    }
                }
            }
        } else if (connection == null) {
            runCatching {
                CarConnection(app).also {
                    connection = it
                    it.type.observeForever(connectionObserver)
                }
            }.onFailure {
                // Without the projection signal assume the worst: this phone may
                // be the one in the dashboard.
                Log.w(TAG, "can't read Android Auto connection state: ${it.message}")
                _signals.update { s -> s.copy(projectingToAndroidAuto = true) }
            }
        }
    }

    fun stop() {
        carUxCollector?.cancel(); carUxCollector = null
        carUx?.stop(); carUx = null
        connection?.let { runCatching { it.type.removeObserver(connectionObserver) } }
        connection = null
        // Unknown again until the next start(): nothing may play while stopped.
        _signals.update { it.copy(carRequiresDistractionOptimization = null) }
    }

    fun confirmPassenger(confirmed: Boolean) {
        _signals.update { it.copy(passengerConfirmed = confirmed) }
    }

    private companion object {
        const val TAG = "DriveMonitor"
    }
}
