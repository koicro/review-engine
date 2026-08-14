package dev.reviewengine.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.assertFailsWith

class ScaleTest {
    @Test
    fun `decimal scale is represented as exact ticks`() {
        val scale = Scale.of(minValue = "-1.0", maxValue = "1.0", stepValue = "0.25")

        assertEquals(8L, scale.maxTick)
        assertEquals("-1", scale.displayString(0))
        assertEquals("0", scale.displayString(4))
        assertEquals("1", scale.displayString(8))
        assertEquals("0.5", scale.normalizedString(4))
        assertEquals("0.25", scale.stepValueString())
    }

    @Test
    fun `range must be exactly divisible by step`() {
        val failure = assertFailsWith<DomainException> {
            Scale.of(minValue = "0", maxValue = "1", stepValue = "0.3")
        }

        assertEquals(DomainErrorCode.INVALID_SCALE, failure.code)
    }

    @Test
    fun `tick validation accepts endpoints and rejects out of bounds`() {
        val scale = Scale.of(maxValue = "5", stepValue = "0.5")

        assertTrue(scale.isValidTick(0))
        assertTrue(scale.isValidTick(10))
        assertFalse(scale.isValidTick(-1))
        assertFalse(scale.isValidTick(11))
        assertEquals(
            DomainErrorCode.INVALID_TICK_INDEX,
            assertFailsWith<DomainException> { scale.display(11) }.code,
        )
    }

    @Test
    fun `non decimal input returns a domain error`() {
        val failure = assertFailsWith<DomainException> {
            Scale.of(maxValue = "NaN", stepValue = "1")
        }

        assertEquals(DomainErrorCode.INVALID_DECIMAL, failure.code)
    }
}
