# Coordination hub — integration note

Stage 1 of the hub client. It lets the app sign in to `hub.beeboentertainment.com`, ask
where the user's home PC (the streamServer) currently is, and write that address
into the app's existing `Prefs.baseUrl` — after which every other screen keeps
working unchanged, because they already read `Prefs.baseUrl`.

Nothing here builds UI. It plugs into the sign-in flow the app already has in
`ui/MainActivity.kt`.

## Files added

| File | What it is |
| --- | --- |
| `app/src/main/java/com/beeboentertainment/auto/hub/HubClient.kt` | The client. Suspend functions over the shared OkHttp + kotlinx-serialization stack. |
| `app/src/main/java/com/beeboentertainment/auto/hub/HubModels.kt` | Wire DTOs (`@Serializable`) + the public `HubSession` / `PcInfo`. |
| `app/src/main/java/com/beeboentertainment/auto/hub/HubException.kt` | Typed error, `HubException(code, message)`. |
| `app/src/main/java/com/beeboentertainment/auto/hub/HubAuth.kt` | One-call helper Activities call; persists the token. |
| `app/src/test/java/com/beeboentertainment/auto/hub/HubModelsJsonTest.kt` | JSON decode + status→message mapping tests (plain JUnit). |

## Additions to existing files (additive only)

`data/Prefs.kt`:

- `var hubToken: String?` — stored like every other string (`getString`/`putString`).
- `fun signOutHub()` — clears only the hub token. `signOut()` is untouched.
- `private const val KEY_HUB_TOKEN = "hubToken"`.

No existing signatures changed. No Gradle dependencies added — this uses the
already-present OkHttp 4.12, kotlinx-serialization-json 1.11, and coroutines.

## HubClient public API

```kotlin
class HubClient(context: Context) {
    suspend fun signup(email: String, password: String): HubSession
    suspend fun login(email: String, password: String): HubSession
    suspend fun findPc(token: String): PcInfo
    suspend fun resolveAndApply(token: String): Boolean   // true => Prefs.baseUrl was set

    companion object {
        const val HUB_BASE_URL = "https://hub.beeboentertainment.com" // override for staging/local
        fun messageFor(code: Int, serverMessage: String?): String
    }
}

data class HubSession(val token: String, val accountId: String, val email: String, val tier: String)
data class PcInfo(
    val online: Boolean, val lastSeen: Long, val baseUrl: String?,
    val connectVia: String, val subscriptionActive: Boolean, val tier: String,
)
class HubException(val code: Int, message: String) : Exception(message)
```

`resolveAndApply(token)` calls `findPc`, and **only** when the PC is
`online && connectVia == "direct" && baseUrl != null` does it write `baseUrl`
into `Prefs.baseUrl` and return `true`; otherwise `false`. Auth / subscription /
pairing failures (401/402/404/409) throw `HubException` with a ready-to-show
message.

Prefer the `HubAuth` helper from UI — it wraps `HubClient` and persists the
token:

```kotlin
object HubAuth {
    suspend fun signIn(context, email, password): HubSession      // login + save hubToken
    suspend fun register(context, email, password): HubSession    // signup + save hubToken
    suspend fun refreshPcAddress(context): Boolean                // uses stored token, applies baseUrl
    fun isSignedIn(context): Boolean
}
```

## Wiring it in — the 2–3 lines that matter

Both edits go in `ui/MainActivity.kt`, which already runs suspend work inside
`lifecycleScope.launch { … }` and holds `prefs`.

**(a) Hub sign-in** — in the existing "Sign in" `onClick`, alongside the
`api.login(...)` call (or from a new email/password pair of fields), replace the
manual login with a hub sign-in that also resolves the PC:

```kotlin
lifecycleScope.launch {
    try {
        HubAuth.signIn(this@MainActivity, email.trim(), password)   // saves hubToken
        val applied = HubAuth.refreshPcAddress(this@MainActivity)   // sets Prefs.baseUrl
        server = prefs.baseUrl                                       // reflect it in the field
        status = if (applied) "Connected to your PC." else "Signed in — your PC is offline."
    } catch (e: HubException) {
        status = e.message ?: "Sign-in failed."
    }
}
```

**(b) Auto-resolve at app start** — so a returning user is pointed at their PC's
current address without doing anything. Add one `LaunchedEffect` in `Screen()`
(next to the existing version-check one):

```kotlin
LaunchedEffect(Unit) {
    runCatching { HubAuth.refreshPcAddress(this@MainActivity) }
        .onSuccess { if (it) server = prefs.baseUrl }
    // On HubException(401): token expired — call prefs.signOutHub() and prompt sign-in.
}
```

That is the whole integration: the rest of the app reads `Prefs.baseUrl` exactly
as it does today.

## Notes / boundaries

- **Stage 2 (WebRTC / `connectVia == "signal"`) is out of scope.** `resolveAndApply`
  returns `false` for a signal-only PC and carries a clearly marked `TODO(stage2)`
  where the WebRTC branch belongs.
- The client uses `Http.client(trustAnyCert = false)` — the `trustAnyCert` knob is
  for the user's own lapsed-cert PC, not the public hub.
- `HubClient` reuses `ApiClient.httpsUpgradeTarget` for the same http→https upgrade
  handling, but deliberately never persists the upgraded hub address to
  `Prefs.baseUrl` (that pref is the PC's address, not the hub's). In production the
  hub is https, so the upgrade loop runs once and returns.
- `Prefs.baseUrl`'s setter normalizes the address, so a malformed `baseUrl` from
  the hub throws `InvalidServerAddressException` rather than being stored.
