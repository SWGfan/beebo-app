package com.beeboentertainment.movie.vault

import android.app.Activity
import android.os.Build
import android.view.WindowManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import coil.request.CachePolicy
import coil.request.ImageRequest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

@Composable
fun PrivateVaultScreen() {
    if (Build.VERSION.SDK_INT < 26) {
        Text("Encrypted private folders require Android 8 or newer. Your other photos and backups are still available.", Modifier.padding(24.dp)); return
    }
    val context = LocalContext.current
    val client = remember { VaultClient() }
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<VaultStatus?>(null) }
    var key by remember { mutableStateOf<VaultCrypto.Unlocked?>(null) }
    var created by remember { mutableStateOf<VaultCrypto.Created?>(null) }
    var savedKey by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("My private folder") }
    var recovery by remember { mutableStateOf("") }
    var useRecovery by remember { mutableStateOf(false) }
    var shareRecovery by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var files by remember { mutableStateOf<List<VaultDisplayFile>>(emptyList()) }
    var preview by remember { mutableStateOf<Pair<VaultDisplayFile, File>?>(null) }
    var changingPassword by remember { mutableStateOf(false) }
    fun lock() {
        key?.close(); created?.unlocked?.close(); key=null;created=null;files=emptyList()
        password="";confirm="";recovery="";savedKey=false;preview?.second?.delete();preview=null;changingPassword=false
    }
    suspend fun refresh() {
        status=client.status()
        key?.let { unlocked -> files=withContext(Dispatchers.Default){client.details(unlocked,status!!.files)} }
    }
    fun task(block: suspend () -> Unit) {
        if(busy)return
        scope.launch { busy=true;message="";try{block()}catch(e:Exception){message=e.message?:"Could not finish. Please try again."}finally{busy=false} }
    }
    val activity=context as? Activity
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val previouslySecure=activity?.window?.attributes?.flags?.and(WindowManager.LayoutParams.FLAG_SECURE)!=0
        activity?.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val observer=LifecycleEventObserver{_,event->if(event==Lifecycle.Event.ON_STOP&&!picking)lock()}
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer);lock();if(!previouslySecure)activity?.window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }
    LaunchedEffect(Unit){busy=true;try{refresh()}catch(e:Exception){message=e.message?:"Private folder unavailable."}finally{busy=false}}
    val saveKey=rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/plain")){ uri ->
        picking=false
        val current=created
        if(uri!=null&&current!=null)task{
            withContext(Dispatchers.IO){context.contentResolver.openOutputStream(uri,"wt")?.bufferedWriter()?.use{out->
                out.write("Beebo private-folder recovery key\nKeep this file somewhere private, separate from the storage computer. Anyone with this key and the encrypted files can unlock them.\n\nFolder ID: ${current.envelope.vaultId}\nRecovery key: ${current.recoveryCode.chunked(8).joinToString("-")}\n\nOpen Photos & backups > Private folder > Use recovery key in your Beebo account, then set a new folder password.")
            }?:error("Could not save the recovery key.")};savedKey=true;message="Recovery key saved. Keep a second copy somewhere safe."
        }
    }
    val pickFiles=rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()){ uris ->
        picking=false
        val unlocked=key
        if(uris.isNotEmpty()&&unlocked!=null)task{for(uri in uris){client.upload(context,uri,unlocked){progress->scope.launch{message=progress}}};refresh();message="Encrypted files saved. Your original phone files were kept."}
    }
    val saveCopy=rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")){uri->
        picking=false
        val current=preview
        if(uri!=null&&current!=null)task{withContext(Dispatchers.IO){context.contentResolver.openOutputStream(uri,"wt")?.use{out->current.second.inputStream().use{it.copyTo(out)}}?:error("Could not save this copy.")};message="Decrypted copy saved to the location you chose."}
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        Text("Private folder",style=MaterialTheme.typography.headlineSmall)
        Text("Photos, videos and documents encrypted on your phone before they reach the computer.",style=MaterialTheme.typography.bodyMedium)
        if(message.isNotBlank())Text(message,style=MaterialTheme.typography.bodyMedium)
        if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
        val currentStatus=status
        val pending=created
        val unlocked=key
        when {
            currentStatus==null -> Button(enabled=!busy,onClick={task{refresh()}}){Text("Try again")}
            pending!=null -> {
                Text("Save your recovery key",style=MaterialTheme.typography.titleLarge)
                Text("This is the backup for your folder password. Losing both means your encrypted files cannot be recovered.")
                SelectionContainerText(pending.recoveryCode.chunked(8).joinToString("-"))
                Button(enabled=!busy,onClick={picking=true;saveKey.launch("Beebo-private-folder-recovery.txt")}){Text(if(savedKey)"Save another recovery copy" else "Save recovery key")}
                if(savedKey)Text("✓ Recovery key saved")
                RecoveryChoice(currentStatus.recovery,shareRecovery,!busy){shareRecovery=it}
                Button(enabled=savedKey&&!busy,onClick={task{
                    client.setup(pending.envelope)
                    key=pending.unlocked;created=null;password="";confirm=""
                    var emailMessage="Private folder created. Your saved recovery key can unlock it."
                    if(shareRecovery)emailMessage=try{client.emailRecovery(currentStatus.recovery,pending.recoveryCode)}catch(e:Exception){"Folder created, but owner backup was not confirmed: ${e.message}. Keep your saved recovery key."}
                    refresh();message=emailMessage
                }}){Text("Finish private-folder setup")}
                TextButton(enabled=!busy,onClick={pending.unlocked.close();created=null;savedKey=false}){Text("Cancel setup")}
            }
            currentStatus.record==null -> {
                OutlinedTextField(value=name,onValueChange={name=it.take(60)},label={Text("Private folder name")},modifier=Modifier.fillMaxWidth(),enabled=!busy,singleLine=true)
                PasswordField("Folder password · at least 12 characters",password,!busy){password=it}
                PasswordField("Confirm folder password",confirm,!busy){confirm=it}
                RecoveryChoice(currentStatus.recovery,shareRecovery,!busy){shareRecovery=it}
                Text("Your current backups stay where they are. Add files here explicitly to make encrypted copies; this does not retroactively protect files already in a shared library.",style=MaterialTheme.typography.bodySmall)
                Button(enabled=!busy,onClick={if(password!=confirm){message="The passwords do not match."}else task{created=withContext(Dispatchers.Default){VaultCrypto.create(name,password.toCharArray())};password="";confirm="";savedKey=false}}){Text("Create private folder")}
            }
            unlocked==null -> {
                if(useRecovery)OutlinedTextField(value=recovery,onValueChange={recovery=it.take(100)},label={Text("Recovery key")},modifier=Modifier.fillMaxWidth(),enabled=!busy)
                else PasswordField("Folder password",password,!busy){password=it}
                Button(enabled=!busy,onClick={task{
                    val opened=withContext(Dispatchers.Default){try{if(useRecovery)VaultCrypto.recover(currentStatus.record.envelope,recovery)else VaultCrypto.unlock(currentStatus.record.envelope,password.toCharArray())}catch(_:Exception){throw IllegalArgumentException("That password or recovery key did not unlock this folder.")}}
                    key=opened;password="";recovery="";changingPassword=useRecovery;refresh()
                }}){Text(if(useRecovery)"Recover folder" else "Unlock folder")}
                TextButton(enabled=!busy,onClick={useRecovery=!useRecovery;password="";recovery=""}){Text(if(useRecovery)"Use my password" else "Forgot folder password? Use recovery key")}
                currentStatus.record.ownerRecovery?.let{Text("You previously sent a recovery backup to ${it.email}. Ask them for the key if you have lost your copy.",style=MaterialTheme.typography.bodySmall)}
                Text("A Beebo sign-in password reset does not unlock encrypted files. You need the folder password or recovery key.",style=MaterialTheme.typography.bodySmall)
            }
            else -> {
                Text(remember(unlocked,currentStatus.record){runCatching{unlocked.decryptMetadata(currentStatus.record.envelope.label,"label").toString(Charsets.UTF_8)}.getOrDefault("My private folder")},style=MaterialTheme.typography.titleLarge)
                Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                    Button(enabled=!busy,onClick={picking=true;pickFiles.launch(arrayOf("*/*"))}){Text("Add files")}
                    OutlinedButton(onClick={lock()}){Text("Lock folder")}
                }
                TextButton(enabled=!busy,onClick={changingPassword=!changingPassword}){Text("Change folder password")}
                if(changingPassword){
                    PasswordField("New folder password · 12 characters minimum",password,!busy){password=it}
                    PasswordField("Confirm new folder password",confirm,!busy){confirm=it}
                    Button(enabled=!busy,onClick={if(password!=confirm)message="The passwords do not match." else task{
                        val updated=withContext(Dispatchers.Default){VaultCrypto.changePassword(currentStatus.record.envelope,unlocked,password.toCharArray())}
                        client.changePassword(currentStatus.record,updated);password="";confirm="";changingPassword=false;refresh();message="Folder password changed. Your existing recovery key still works."
                    }}){Text("Save new password")}
                }
                if (currentStatus.record.ownerRecovery == null && currentStatus.recovery.available) {
                    RecoveryChoice(currentStatus.recovery, shareRecovery, !busy) { shareRecovery = it }
                    if (shareRecovery) {
                        OutlinedTextField(value = recovery, onValueChange = { recovery = it.take(100) }, label = { Text("Your saved recovery key") }, modifier = Modifier.fillMaxWidth(), enabled = !busy)
                        Button(enabled = !busy && recovery.isNotBlank(), onClick = { task {
                            withContext(Dispatchers.Default) { VaultCrypto.recover(currentStatus.record.envelope, recovery).close() }
                            val outcome = client.emailRecovery(currentStatus.recovery, recovery)
                            recovery = ""; refresh(); message = outcome
                        } }) { Text("Send owner recovery backup") }
                    }
                }
                if(files.isEmpty())Text("No private files yet. Only files you add here are encrypted.")
                files.forEach{file->
                    OutlinedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp)) {
                        Text(file.details.name,style=MaterialTheme.typography.titleSmall)
                        Text(if(file.details.size>=0)"${file.details.size/1024} KB · Encrypted on the computer" else "Encrypted on the computer",style=MaterialTheme.typography.bodySmall)
                        TextButton(enabled=!busy,onClick={task{preview?.second?.delete();preview=file to client.download(context,file,unlocked)}}){Text("Open private file")}
                    } }
                }
            }
        }
    }
    preview?.let{(file,local)->
        Dialog(onDismissRequest={local.delete();preview=null},properties=DialogProperties(usePlatformDefaultWidth=false,securePolicy=SecureFlagPolicy.SecureOn)) {
            Surface(Modifier.fillMaxWidth().fillMaxHeight(.92f)){Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
                Text(file.details.name,style=MaterialTheme.typography.titleMedium)
                Box(Modifier.weight(1f).fillMaxWidth()){
                    when{
                        file.details.mime.startsWith("image/")->AsyncImage(model=ImageRequest.Builder(context).data(local).diskCachePolicy(CachePolicy.DISABLED).memoryCachePolicy(CachePolicy.DISABLED).build(),contentDescription=file.details.name,modifier=Modifier.fillMaxSize())
                        file.details.mime.startsWith("video/")||file.details.mime.startsWith("audio/")->PrivateVideo(local)
                        else->Text("This document is safely decrypted on this phone. Save a copy to open it with your preferred app.")
                    }
                }
                Text("Saving a copy puts an unencrypted file in the location you choose.",style=MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
                    Button(enabled=!busy,onClick={picking=true;saveCopy.launch(file.details.name.substringAfterLast('/').substringAfterLast('\\'))}){Text("Save a copy")}
                    TextButton(onClick={local.delete();preview=null}){Text("Close")}
                }
            }}
        }
    }
}

@Composable private fun PasswordField(label:String,value:String,enabled:Boolean,onChange:(String)->Unit){
    OutlinedTextField(value=value,onValueChange={onChange(it.take(256))},label={Text(label)},enabled=enabled,singleLine=true,visualTransformation=PasswordVisualTransformation(),modifier=Modifier.fillMaxWidth())
}
@Composable private fun SelectionContainerText(value:String){androidx.compose.foundation.text.selection.SelectionContainer{Text(value,style=MaterialTheme.typography.bodyLarge)}}
@Composable private fun RecoveryChoice(options:VaultRecoveryOptions,checked:Boolean,enabled:Boolean,onChange:(Boolean)->Unit){
    OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
        Row{Checkbox(checked=checked,onCheckedChange=onChange,enabled=enabled&&options.available);Text("Send a recovery backup to the account owner",Modifier.padding(top=12.dp))}
        if(options.available)Text("Optional. A recovery key will be emailed to ${options.ownerEmail}; a notice goes to ${options.userEmail}. This lets the account owner unlock your folder. An emailed key cannot be recalled. Your everyday password is never sent.",style=MaterialTheme.typography.bodySmall)
        else Text("Owner recovery needs an email address on your profile, a signed-in Beebo account owner, and working email delivery in desktop Settings. You can still use your own saved recovery key.",style=MaterialTheme.typography.bodySmall)
    }}
}
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable private fun PrivateVideo(file:File){
    val context=LocalContext.current
    val player=remember(file){ExoPlayer.Builder(context).build().apply{setMediaItem(MediaItem.fromUri(android.net.Uri.fromFile(file)));prepare()}}
    DisposableEffect(player){onDispose{player.release()}}
    AndroidView(factory={PlayerView(it).apply{this.player=player;useController=true}},modifier=Modifier.fillMaxSize())
}
