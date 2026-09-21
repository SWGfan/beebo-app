package com.beeboentertainment.movie.vault

import com.google.crypto.tink.*
import com.google.crypto.tink.aead.AeadConfig
import com.google.crypto.tink.streamingaead.StreamingAeadConfig
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.InputStream
import java.io.OutputStream
import java.security.SecureRandom
import okio.ByteString.Companion.toByteString
import okio.ByteString.Companion.decodeBase64
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

@Serializable data class VaultEnvelope(val version: Int = 1, val vaultId: String, val iterations: Int = 600000,
    val salt: String, val passwordKey: String, val recoveryKey: String, val label: String)
@Serializable data class VaultFileDetails(val name: String, val mime: String, val size: Long = -1)
@Serializable private data class VaultSecrets(val stream: String, val metadata: String)

/** Tink authenticates the file stream. The password only wraps independent, randomly generated keys. */
internal object VaultCrypto {
    private val random = SecureRandom()
    private val json = Json { ignoreUnknownKeys = true }
    init { AeadConfig.register(); StreamingAeadConfig.register() }
    fun b64(bytes: ByteArray): String = bytes.toByteString().base64()
    private fun un64(value: String) = requireNotNull(value.decodeBase64()).toByteArray()
    private fun bytes(count: Int) = ByteArray(count).also(random::nextBytes)
    private fun derive(password: CharArray, salt: String): ByteArray {
        val spec = PBEKeySpec(password, un64(salt), 600000, 256)
        return try { SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded } finally { spec.clearPassword() }
    }
    private fun wrap(key: ByteArray, clear: ByteArray, aad: String): String {
        val nonce = bytes(12); val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad.toByteArray(Charsets.UTF_8)); return b64(nonce + cipher.doFinal(clear))
    }
    private fun unwrap(key: ByteArray, value: String, aad: String): ByteArray {
        val encrypted = un64(value); require(encrypted.size in 29..8192)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, encrypted.copyOfRange(0,12)))
        cipher.updateAAD(aad.toByteArray(Charsets.UTF_8)); return cipher.doFinal(encrypted,12,encrypted.size-12)
    }
    private fun keyset(template: String): String = TinkJsonProtoKeysetFormat.serializeKeyset(
        KeysetHandle.generateNew(KeyTemplates.get(template)), InsecureSecretKeyAccess.get())
    private fun recoveryBytes(code: String): ByteArray {
        val clean = code.filterNot { it.isWhitespace() || it == '-' }.uppercase()
        require(clean.matches(Regex("[A-F0-9]{64}"))) { "Enter the complete 64-character recovery key." }
        return clean.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }
    data class Created(val envelope: VaultEnvelope, val recoveryCode: String, val unlocked: Unlocked)
    fun create(label: String, password: CharArray): Created {
        require(password.size in 12..256) { "Use a folder password of 12 to 256 characters." }
        require(label.trim().length in 1..60) { "Name your private folder (up to 60 characters)." }
        val id = UUID.randomUUID().toString(); val salt = b64(bytes(16)); val recovery = bytes(32)
        val secrets = json.encodeToString(VaultSecrets.serializer(), VaultSecrets(keyset("AES256_GCM_HKDF_1MB"), keyset("AES256_GCM"))).toByteArray(Charsets.UTF_8)
        val derived = derive(password, salt)
        try {
            val unlocked = Unlocked(id, secrets.copyOf())
            return Created(VaultEnvelope(vaultId = id, salt = salt,
                passwordKey = wrap(derived, secrets, "beebo-vault:$id:password:v1"),
                recoveryKey = wrap(recovery, secrets, "beebo-vault:$id:recovery:v1"),
                label = unlocked.encryptMetadata(label.trim().toByteArray(Charsets.UTF_8), "label")),
                recovery.joinToString("") { "%02X".format(it.toInt() and 255) }, unlocked)
        } finally { derived.fill(0); secrets.fill(0); recovery.fill(0); password.fill('\u0000') }
    }
    fun unlock(envelope: VaultEnvelope, password: CharArray): Unlocked {
        require(envelope.version == 1 && envelope.iterations == 600000 && un64(envelope.salt).size == 16)
        val key = derive(password, envelope.salt)
        return try { Unlocked(envelope.vaultId, unwrap(key, envelope.passwordKey, "beebo-vault:${envelope.vaultId}:password:v1")) }
        finally { key.fill(0); password.fill('\u0000') }
    }
    fun recover(envelope: VaultEnvelope, code: String): Unlocked {
        require(envelope.version == 1); val key = recoveryBytes(code)
        return try { Unlocked(envelope.vaultId, unwrap(key, envelope.recoveryKey, "beebo-vault:${envelope.vaultId}:recovery:v1")) }
        finally { key.fill(0) }
    }
    fun changePassword(envelope: VaultEnvelope, unlocked: Unlocked, password: CharArray): VaultEnvelope {
        require(password.size in 12..256); require(envelope.vaultId == unlocked.id)
        val salt = b64(bytes(16)); val key = derive(password,salt)
        return try { envelope.copy(salt = salt, passwordKey = wrap(key, unlocked.secretBytes(), "beebo-vault:${envelope.vaultId}:password:v1")) }
        finally { key.fill(0); password.fill('\u0000') }
    }
    class Unlocked(val id: String, private val secret: ByteArray) : AutoCloseable {
        private var closed = false
        private var stream: StreamingAead?
        private var metadata: Aead?
        init {
            val bundle = json.decodeFromString(VaultSecrets.serializer(), secret.toString(Charsets.UTF_8))
            stream = TinkJsonProtoKeysetFormat.parseKeyset(bundle.stream, InsecureSecretKeyAccess.get()).getPrimitive(RegistryConfiguration.get(), StreamingAead::class.java)
            metadata = TinkJsonProtoKeysetFormat.parseKeyset(bundle.metadata, InsecureSecretKeyAccess.get()).getPrimitive(RegistryConfiguration.get(), Aead::class.java)
        }
        internal fun secretBytes(): ByteArray { check(!closed); return secret }
        private fun aad(purpose: String) = "beebo-vault:$id:$purpose:v1".toByteArray(Charsets.UTF_8)
        @Synchronized fun encryptMetadata(clear: ByteArray, item: String): String = b64(requireNotNull(metadata).encrypt(clear, aad("metadata:$item")))
        @Synchronized fun decryptMetadata(value: String, item: String): ByteArray = requireNotNull(metadata).decrypt(un64(value), aad("metadata:$item"))
        fun encryptFile(input: InputStream, output: OutputStream, fileId: String): Long {
            val primitive = synchronized(this) { requireNotNull(stream) }
            return primitive.newEncryptingStream(output, aad("file:$fileId")).use { encrypted -> copyBounded(input,encrypted) }
        }
        fun decryptFile(input: InputStream, output: OutputStream, fileId: String): Long {
            val primitive = synchronized(this) { requireNotNull(stream) }
            return primitive.newDecryptingStream(input, aad("file:$fileId")).use { decrypted -> copyBounded(decrypted,output) }
        }
        override fun close() = synchronized(this) { closed = true; secret.fill(0); stream = null; metadata = null }
        private fun copyBounded(input: InputStream, output: OutputStream): Long {
            val buffer = ByteArray(64*1024); var total = 0L
            try { while (true) {
                synchronized(this) { check(!closed) { "Private folder locked." } }
                val n = input.read(buffer); if (n < 0) break; if (n == 0) continue
                total += n; require(total <= 1024L*1024*1024 - 65536) { "Private files can be up to 1 GB." }; output.write(buffer,0,n)
            }; return total } finally { buffer.fill(0) }
        }
    }
}
