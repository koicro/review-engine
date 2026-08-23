package dev.reviewengine.application

import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import java.io.ByteArrayOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class PictureStorageTest {
    @Test
    fun `stream limit rejects the first byte beyond the configured maximum`() {
        assertEquals(100_000_000L, MAX_PICTURE_SIZE_BYTES)
        val destination = ByteArrayOutputStream()
        val limited = LimitedOutputStream(destination, 3)
        limited.write(byteArrayOf(1, 2, 3))

        val failure = assertFailsWith<DomainException> { limited.write(4) }

        assertEquals(DomainErrorCode.PAYLOAD_TOO_LARGE, failure.code)
        assertEquals(3L, limited.bytesWritten)
        assertEquals(listOf<Byte>(1, 2, 3), destination.toByteArray().toList())
    }
}
