package com.beeboentertainment.movie.vault

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.beeboentertainment.movie.BeeboApp
import com.beeboentertainment.movie.core.UrlUtils
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID

@Serializable data class VaultOwnerRecovery(val email: String, val sentAt: Long)
@Serializable data class VaultRecord(val envelope: VaultEnvelope, val revision: Int = 1, val ownerRecovery: VaultOwnerRecovery? = null)
@Serializable data class VaultRemoteFile(val id: String, val metadata: String, val bytes: Long = 0)
@Serializable data class VaultRecoveryOptions(val available: Boolean = false, val ownerEmail: String = "", val userEmail: String = "")
@Serializable data class VaultStatus(val record: VaultRecord? = null, val files: List<VaultRemoteFile> = emptyList(), val recovery: VaultRecoveryOptions = VaultRecoveryOptions())
internal data class VaultDisplayFile(val remote: VaultRemoteFile, val details: VaultFileDetails)

internal class VaultClient {
    private val session = BeeboApp.instance.session
    private val base = session.baseUrl
    private val token = session.token ?: ""
    private val http = BeeboApp.instance.api.okHttp.newBuilder().followRedirects(false).followSslRedirects(false).build()
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private fun builder(path: String) = Request.Builder()
        .url(UrlUtils.endpoint(base, path) ?: throw IOException("Connect to your home computer first."))
        .header("Authorization", "Bearer $token")
    private fun answer(request: Request): JsonObject = http.newCall(request).execute().use { response ->
        val body = runCatching { json.parseToJsonElement(response.body?.string().orEmpty()).jsonObject }.getOrNull()
        if (!response.isSuccessful || body?.get("ok")?.jsonPrimitive?.booleanOrNull != true)
            throw IOException(if (response.code == 404) "Update the Beebo desktop program to use private folders." else body?.get("error")?.jsonPrimitive?.contentOrNull ?: "Could not reach your private folder (HTTP ${response.code}).")
        body
    }
    private fun post(path: String, body: JsonObject): JsonObject {
        val request = builder(path)
        if (path.endsWith("/recovery-email")) request.header("X-Beebo-Encrypted-Only", "1")
        return answer(request.post(body.toString().toRequestBody("application/json".toMediaType())).build())
    }
    suspend fun status(): VaultStatus = withContext(Dispatchers.IO) {
        json.decodeFromJsonElement(VaultStatus.serializer(), answer(builder("/api/private-vault").get().build()))
    }
    suspend fun setup(envelope: VaultEnvelope): VaultRecord = withContext(Dispatchers.IO) {
        val response = post("/api/private-vault/setup", buildJsonObject { put("envelope", json.encodeToJsonElement(VaultEnvelope.serializer(), envelope)) })
        json.decodeFromJsonElement(VaultRecord.serializer(), response.getValue("record"))
    }
    suspend fun changePassword(record: VaultRecord, envelope: VaultEnvelope): VaultRecord = withContext(Dispatchers.IO) {
        val response = post("/api/private-vault/password", buildJsonObject { put("revision", record.revision); put("envelope", json.encodeToJsonElement(VaultEnvelope.serializer(), envelope)) })
        json.decodeFromJsonElement(VaultRecord.serializer(), response.getValue("record"))
    }
    suspend fun emailRecovery(options: VaultRecoveryOptions, code: String): String = withContext(Dispatchers.IO) {
        val response = post("/api/private-vault/recovery-email", buildJsonObject {
            put("consent", true); put("ownerEmail", options.ownerEmail); put("userEmail", options.userEmail)
            put("recoveryCode", code.filterNot { it == '-' || it.isWhitespace() }.uppercase())
        })
        if (response["notificationSent"]?.jsonPrimitive?.booleanOrNull == true)
            "Recovery backup sent to ${options.ownerEmail}. A confirmation was sent to ${options.userEmail}."
        else "Recovery backup sent to ${options.ownerEmail}. Your initial notice was sent, but the final confirmation email failed."
    }
    fun details(key: VaultCrypto.Unlocked, files: List<VaultRemoteFile>): List<VaultDisplayFile> = files.map { file ->
        VaultDisplayFile(file, json.decodeFromString(VaultFileDetails.serializer(), key.decryptMetadata(file.metadata, file.id).toString(Charsets.UTF_8)))
    }
    suspend fun upload(context: Context, uri: Uri, key: VaultCrypto.Unlocked, progress: (String) -> Unit) = withContext(Dispatchers.IO) {
        val id = UUID.randomUUID().toString(); var name = "File"; var size = -1L
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),null,null,null)?.use { cursor ->
            if (cursor.moveToFirst()) { name = cursor.getString(0)?.take(180) ?: name; if (!cursor.isNull(1)) size = cursor.getLong(1) }
        }
        require(size < 1024L*1024*1024 - 65536) { "Private files can be up to 1 GB." }
        val directory = File(context.cacheDir, "vault-upload").also { it.mkdirs() }
        val encrypted = File.createTempFile("encrypted-", ".tmp", directory)
        try {
            progress("Encrypting on your phone…")
            val count = context.contentResolver.openInputStream(uri)?.use { source ->
                encrypted.outputStream().use { target -> key.encryptFile(source,target,id) }
            } ?: throw IOException("That file could not be opened.")
            val metadata = key.encryptMetadata(json.encodeToString(VaultFileDetails.serializer(), VaultFileDetails(name,context.contentResolver.getType(uri) ?: "application/octet-stream",count)).toByteArray(Charsets.UTF_8), id)
            val digest = MessageDigest.getInstance("SHA-256")
            encrypted.inputStream().use { input -> val buffer=ByteArray(64*1024);while(true){val n=input.read(buffer);if(n<0)break;digest.update(buffer,0,n)} }
            val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
            encrypted.inputStream().use { source ->
                val buffer = ByteArray(512*1024); var offset=0L
                while(offset<encrypted.length()) {
                    val n=source.read(buffer);if(n<1)throw IOException("The encrypted file could not be read.")
                    val url="/api/private-vault/file?id=$id&vaultId=${key.id}&total=${encrypted.length()}&offset=$offset"
                    val response=answer(builder(url).header("X-Beebo-Vault-Metadata",metadata).header("X-Beebo-Vault-SHA256",hash)
                        .post(buffer.toRequestBody("application/octet-stream".toMediaType(),0,n)).build())
                    offset+=n
                    if(response["offset"]?.jsonPrimitive?.longOrNull!=offset)throw IOException("Upload verification failed. Please try again.")
                    progress("Uploading encrypted file… ${offset*100/encrypted.length()}%")
                }
            }
        } finally { encrypted.delete() }
    }
    suspend fun download(context: Context, file: VaultDisplayFile, key: VaultCrypto.Unlocked): File = withContext(Dispatchers.IO) {
        val directory=File(context.cacheDir,"vault-preview").also{it.mkdirs()}
        val result=File.createTempFile("private-",".tmp",directory)
        try {
            http.newCall(builder("/api/private-vault/file?id=${file.remote.id}").get().build()).execute().use { response ->
                if(!response.isSuccessful)throw IOException("Could not download the private file.")
                response.body?.byteStream()?.use{source -> result.outputStream().use{target -> key.decryptFile(source,target,file.remote.id)}} ?: throw IOException("The private file was empty.")
            }
            if(file.details.size>=0&&result.length()!=file.details.size)throw IOException("The private file did not pass verification.")
            result
        } catch(e:Exception){result.delete();throw e}
    }
}
