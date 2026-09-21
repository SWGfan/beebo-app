package com.beeboentertainment.auto.drive

import android.car.Car
import android.car.drivingstate.CarUxRestrictions
import android.car.drivingstate.CarUxRestrictionsManager
import android.content.Context
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Android Automotive OS only: follows the car's UX restrictions.
 *
 * [requiresDistractionOptimization] is the only value a parked app may act on
 * (see developer.android.com/training/cars/parked/automotive-os). It starts as
 * null — unknown — and stays null if the car service can't be reached, which
 * [VideoGate] treats as "not parked".
 *
 * Only construct this after checking PackageManager.FEATURE_AUTOMOTIVE: the
 * `android.car` classes exist only on car builds of Android (the manifest
 * declares the library as not required so phones can still install the app).
 */
class CarUxWatcher(context: Context) {

    private val app = context.applicationContext
    private val _requires = MutableStateFlow<Boolean?>(null)
    val requiresDistractionOptimization: StateFlow<Boolean?> = _requires.asStateFlow()

    private var car: Car? = null
    private var manager: CarUxRestrictionsManager? = null

    fun start() {
        if (car != null) return
        runCatching {
            val c = Car.createCar(app) ?: error("car service unavailable")
            car = c
            val m = c.getCarManager(Car.CAR_UX_RESTRICTION_SERVICE) as? CarUxRestrictionsManager
                ?: error("no UX restriction service")
            manager = m
            apply(m.currentCarUxRestrictions)
            m.registerListener { r -> apply(r) }
        }.onFailure {
            Log.w(TAG, "can't read car UX restrictions; video stays off: ${it.message}")
            _requires.value = null
        }
    }

    fun stop() {
        runCatching { manager?.unregisterListener() }
        runCatching { car?.disconnect() }
        manager = null
        car = null
        _requires.value = null
    }

    private fun apply(r: CarUxRestrictions?) {
        _requires.value = r?.isRequiresDistractionOptimization
    }

    private companion object {
        const val TAG = "CarUxWatcher"
    }
}
