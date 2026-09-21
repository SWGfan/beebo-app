package com.beeboentertainment.movie.ui.screens

import android.app.Activity
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.android.billingclient.api.Purchase
import com.beeboentertainment.movie.billing.HouseholdBillingClient
import com.beeboentertainment.movie.billing.PlanCatalog
import com.beeboentertainment.movie.billing.PlayBillingManager
import com.beeboentertainment.movie.core.TvFeatures
import com.beeboentertainment.movie.data.ApiException
import com.beeboentertainment.movie.ui.tv.LocalIsTv
import kotlinx.coroutines.launch

/**
 * "Household plan" (More > Account, Play build only): sign in, see the household's current plan
 * and extra-seat count, and change either through Google Play's own purchase sheet. Never states a
 * price or uses any of the words build.gradle.kts's `checkPlayDebugPolicy` (and PaymentsGuardTest)
 * refuse - Play's own purchase sheet is the one place a price is shown. See
 * docs/GOOGLE-PLAY-BILLING-AND-SEAT-ADDON.md sections 6 and 7.6.
 *
 * The screen never decides its own entitlement from a Play [Purchase] - only the Worker's
 * `/play/activate` answer (via [HouseholdBillingClient]) is trusted, exactly as the desktop app
 * trusts the signed licence token over anything derived locally (docs section 6.4).
 */
@Composable
fun HouseholdPlanScreen(
    billingClient: HouseholdBillingClient = remember { HouseholdBillingClient() },
) {
    // A TV shows a line instead of the purchase controls: no Play sheet is launched from there.
    val notice = TvFeatures.purchaseNotice(LocalIsTv.current)
    if (notice == null) {
        HouseholdPlanPurchases(billingClient)
        return
    }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Household plan", style = MaterialTheme.typography.headlineSmall)
        Text(notice)
    }
}

@Composable
private fun HouseholdPlanPurchases(billingClient: HouseholdBillingClient) {
    val context = LocalContext.current
    val activity = context as? Activity
    val scope = rememberCoroutineScope()

    var token by remember { mutableStateOf<String?>(null) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("") }
    var plan by remember { mutableStateOf<String?>(null) }
    var seats by remember { mutableStateOf(0) }
    var maxExtraSeats by remember { mutableStateOf(PlanCatalog.MAX_EXTRA_SEATS) }
    var working by remember { mutableStateOf(false) }

    val manager = remember {
        PlayBillingManager(context) { purchases ->
            scope.launch {
                for (purchase in purchases) {
                    val action = PlayBillingManager.purchaseAction(purchase.purchaseState, purchase.isAcknowledged)
                    if (action != PlayBillingManager.PurchaseAction.ACTIVATE_AND_ACKNOWLEDGE) continue
                    val currentToken = token ?: continue
                    val productId = purchase.products.firstOrNull() ?: continue
                    try {
                        val result = billingClient.activatePlayPurchase(currentToken, purchase.purchaseToken, productId)
                        plan = result.plan
                        seats = result.seats
                        status = "Your household plan is up to date."
                    } catch (error: ApiException) {
                        status = error.message ?: "Your plan will be reconciled automatically shortly."
                    }
                }
            }
        }
    }

    DisposableEffect(Unit) {
        scope.launch { manager.connect() }
        onDispose { manager.disconnect() }
    }

    fun refreshSeats() {
        val currentToken = token ?: return
        scope.launch {
            try {
                val result = billingClient.currentSeats(currentToken)
                seats = result.seats
                maxExtraSeats = result.maxExtraSeats
            } catch (error: ApiException) {
                status = error.message ?: "Could not check your household size."
            }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Household plan", style = MaterialTheme.typography.headlineSmall)

        if (token == null) {
            Text("Sign in with the same email you use on Beebo's desktop app.")
            OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text("Email") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = password, onValueChange = { password = it }, label = { Text("Password") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
            Button(onClick = {
                working = true
                scope.launch {
                    try {
                        val result = billingClient.signIn(email, password)
                        token = result.token
                        plan = result.plan
                        refreshSeats()
                        status = ""
                    } catch (error: ApiException) {
                        status = error.message ?: "Could not sign in."
                    } finally { working = false }
                }
            }, enabled = !working && email.isNotBlank() && password.isNotBlank()) { Text("Sign in") }
        } else {
            val planLabel = when (plan) {
                "beebo-standard" -> "Beebo Standard"
                "beebo-standard-4k" -> "Beebo Standard 4K"
                else -> "no household plan yet"
            }
            Text("You're on $planLabel.")
            Text("Extra household spots: $seats (up to $maxExtraSeats).")

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(enabled = !working && activity != null, onClick = {
                    working = true
                    scope.launch {
                        val currentToken = token
                        val (household, seatsProducts) = manager.queryProducts()
                        val details = household.firstOrNull()
                        if (details != null && activity != null && currentToken != null) {
                            try {
                                val accountId = billingClient.playAccountId(currentToken)
                                manager.launchPurchase(activity, accountId, details, "beebo-standard", seatsProducts.firstOrNull(), seats)
                            } catch (error: ApiException) {
                                status = error.message ?: "Something went wrong getting ready. Try again."
                            }
                        } else {
                            status = "Beebo Standard isn't available from Google Play right now."
                        }
                        working = false
                    }
                }) { Text("Get Beebo Standard") }

                Button(enabled = !working && activity != null, onClick = {
                    working = true
                    scope.launch {
                        val currentToken = token
                        val (household, seatsProducts) = manager.queryProducts()
                        val details = household.firstOrNull()
                        if (details != null && activity != null && currentToken != null) {
                            try {
                                val accountId = billingClient.playAccountId(currentToken)
                                manager.launchPurchase(activity, accountId, details, "beebo-standard-4k", seatsProducts.firstOrNull(), seats)
                            } catch (error: ApiException) {
                                status = error.message ?: "Something went wrong getting ready. Try again."
                            }
                        } else {
                            status = "Beebo Standard 4K isn't available from Google Play right now."
                        }
                        working = false
                    }
                }) { Text("Get Beebo Standard 4K") }
            }

            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                IconButton(enabled = seats > 0 && !working, onClick = { seats = (seats - 1).coerceAtLeast(0) }) { Text("-") }
                Text("$seats extra spots")
                IconButton(enabled = seats < maxExtraSeats && !working, onClick = { seats = (seats + 1).coerceAtMost(maxExtraSeats) }) { Text("+") }
            }

            if (status.isNotBlank()) Text(status, color = MaterialTheme.colorScheme.secondary)
        }
    }
}
