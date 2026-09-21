package com.beeboentertainment.movie.vault

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.UUID

class VaultCryptoTest {
    @Test fun passwordRecoveryAndPasswordChangeKeepTheSamePrivateFiles() {
        val created=VaultCrypto.create("Family receipts","Correct password 2026".toCharArray())
        try {
            val encrypted=created.unlocked.encryptMetadata("secret name".toByteArray(),"example")
            val recovered=VaultCrypto.recover(created.envelope,created.recoveryCode)
            try {
                assertEquals("secret name",recovered.decryptMetadata(encrypted,"example").toString(Charsets.UTF_8))
                val updated=VaultCrypto.changePassword(created.envelope,recovered,"Another good password 2026".toCharArray())
                assertFails{VaultCrypto.unlock(updated,"Correct password 2026".toCharArray())}
                VaultCrypto.unlock(updated,"Another good password 2026".toCharArray()).use{assertEquals("secret name",it.decryptMetadata(encrypted,"example").toString(Charsets.UTF_8))}
                VaultCrypto.recover(updated,created.recoveryCode).use{assertEquals(created.envelope.vaultId,it.id)}
            }finally{recovered.close()}
            assertFails{VaultCrypto.recover(created.envelope,"0".repeat(64))}
            assertFails{created.unlocked.decryptMetadata(encrypted,"different-file")}
        }finally{created.unlocked.close()}
    }
    @Test fun streamingFileRejectsTamperingTruncationAndWrongFileIdentity() {
        val created=VaultCrypto.create("Private photos","Another strong password".toCharArray())
        try {
            val original=ByteArray(1300000){(it%251).toByte()};val id=UUID.randomUUID().toString()
            val output=ByteArrayOutputStream();created.unlocked.encryptFile(original.inputStream(),output,id)
            val encrypted=output.toByteArray();assertFalse(encrypted.contentEquals(original))
            val decoded=ByteArrayOutputStream();created.unlocked.decryptFile(encrypted.inputStream(),decoded,id);assertArrayEquals(original,decoded.toByteArray())
            assertFails{created.unlocked.decryptFile(encrypted.copyOf(encrypted.size-1).inputStream(),ByteArrayOutputStream(),id)}
            val tampered=encrypted.copyOf();tampered[tampered.size/2]=(tampered[tampered.size/2].toInt() xor 1).toByte()
            assertFails{created.unlocked.decryptFile(tampered.inputStream(),ByteArrayOutputStream(),id)}
            assertFails{created.unlocked.decryptFile(encrypted.inputStream(),ByteArrayOutputStream(),"wrong-file")}
            created.unlocked.close();assertFails{created.unlocked.encryptMetadata(byteArrayOf(1),id)}
        }finally{created.unlocked.close()}
    }
    private fun assertFails(action:()->Unit){var failed=false;try{action()}catch(_:Exception){failed=true};assertTrue("Operation must reject invalid keys or unauthenticated data",failed)}
}
