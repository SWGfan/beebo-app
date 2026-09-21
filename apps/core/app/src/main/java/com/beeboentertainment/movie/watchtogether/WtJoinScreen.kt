package com.beeboentertainment.movie.watchtogether

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.UnauthorizedException
import com.beeboentertainment.movie.player.PartyVideoResolver
import com.beeboentertainment.movie.player.PlayerActivity
import com.beeboentertainment.movie.server.SafeText
import com.beeboentertainment.movie.server.ServerException
import com.beeboentertainment.movie.ui.tv.DpadTextField
import kotlinx.coroutines.launch

/**
 * Hands a room code from the join screen to the player in memory. Not an Intent extra: those can end up
 * in task snapshots and system dumps, and a room code is a credential.
 */
object WtHandoff {
    @Volatile private var pending: String? = null
    @Volatile private var at = 0L

    fun put(code: String) { pending = code; at = System.currentTimeMillis() }

    /** One use, and only for a minute. */
    fun take(): String? {
        val c = pending
        val fresh = System.currentTimeMillis() - at < 60_000
        pending = null
        return if (fresh) c else null
    }
}

/**
 * Join a Watch together room from an invite: paste the link or the code, see what is being watched and
 * who is hosting, then open the player, which follows the room. Only people signed in to this Beebo can
 * join, and the link's own address is ignored: the app always talks to its own server.
 */
@Composable
fun JoinWatchTogetherScreen(onUnauthorized: () -> Unit) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var found by remember { mutableStateOf<Pair<String, WtPreview>?>(null) }

    fun look(codeText: String) {
        val code = WtProtocol.codeFromInvite(codeText)
        if (code == null) { message = "That doesn't look like an invite link or code."; return }
        busy = true; message = null; found = null
        scope.launch {
            try {
                val p = WtClient.get().preview(code)
                if (!WtProtocol.isMediaKind(p.media.kind) || !WtProtocol.isSafeMediaId(p.media.id)) message = "This room's title can't be opened here."
                else found = code to p
            } catch (e: UnauthorizedException) { onUnauthorized() }
            catch (e: ServerException) { message = WtProtocol.message(e.code, e.message) }
            catch (e: Exception) { message = e.message ?: "That didn't work." }
            finally { busy = false }
        }
    }

    fun open(code: String, p: WtPreview) {
        busy = true; message = null
        scope.launch {
            try {
                val app = BeeboApp.instance
                val item = PartyVideoResolver.resolve(app.api, p.media.id)
                val stream = UrlUtils.join(app.session.baseUrl, item?.stream)
                if (item == null || stream == null) {
                    message = "This account can't open that title on this Beebo."
                } else {
                    WtHandoff.put(code)
                    context.startActivity(
                        PlayerActivity.intentFor(
                            context, item.id, item.kind, item.title.ifBlank { p.media.title }, stream,
                            posterUrl = UrlUtils.join(app.session.baseUrl, item.poster),
                            // The room decides where to start: no "resume from..." question first.
                            resumePositionMs = 0L, showKey = item.showKey
                        )
                    )
                    text = ""; found = null
                }
            } catch (e: Exception) { message = e.message ?: "That didn't work." }
            finally { busy = false }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Join a watch together room", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Ask the host for the invite link or code. Paste it here to see what they're watching, then join. You watch from your own Beebo sign-in, in step with everyone.",
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        DpadTextField(Modifier.fillMaxWidth()) { tv ->
            OutlinedTextField(value = text, onValueChange = { text = it.take(2000); message = null; found = null }, label = { Text("Invite link or code") }, singleLine = true, modifier = tv.fillMaxWidth())
        }
        OutlinedButton(enabled = !busy, onClick = { clipboard.getText()?.text?.let { text = it.take(2000); message = null; found = null } }) { Text("Paste from clipboard") }
        Button(enabled = !busy && text.isNotBlank(), onClick = { look(text) }) { Text("Look up the room") }
        message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        found?.let { (code, p) ->
            Text(SafeText.clean(p.media.title, 120).ifBlank { "A title on this Beebo" }, style = MaterialTheme.typography.titleMedium)
            Text(
                listOfNotNull(SafeText.clean(p.hostName, WtProtocol.NAME_MAX).takeIf { it.isNotBlank() }?.let { "Hosted by $it" }, "${p.count} ${if (p.count == 1) "person" else "people"} in the room").joinToString(" · "),
                fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Button(enabled = !busy, onClick = { open(code, p) }) { Text("Join and watch") }
        }
        Spacer(Modifier.height(4.dp))
    }
}
