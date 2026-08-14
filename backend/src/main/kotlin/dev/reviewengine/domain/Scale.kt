package dev.reviewengine.domain

import java.math.BigDecimal
import java.math.MathContext

/**
 * An exact decimal score scale. Scores are persisted as integer ticks, never floating point.
 */
class Scale private constructor(
    val minValue: BigDecimal,
    val maxValue: BigDecimal,
    val stepValue: BigDecimal,
    val maxTick: Long,
) {
    companion object {
        fun of(
            minValue: String = "0",
            maxValue: String,
            stepValue: String,
        ): Scale {
            val min = minValue.toExactDecimal("minValue")
            val max = maxValue.toExactDecimal("maxValue")
            val step = stepValue.toExactDecimal("stepValue")

            if (min >= max) {
                domainFailure(
                    DomainErrorCode.INVALID_SCALE,
                    "Scale minimum must be less than its maximum",
                    "minValue" to minValue,
                    "maxValue" to maxValue,
                )
            }
            if (step <= BigDecimal.ZERO) {
                domainFailure(
                    DomainErrorCode.INVALID_SCALE,
                    "Scale step must be greater than zero",
                    "stepValue" to stepValue,
                )
            }

            val ticks = (max - min).divideAndRemainder(step)
            if (ticks[1].compareTo(BigDecimal.ZERO) != 0) {
                domainFailure(
                    DomainErrorCode.INVALID_SCALE,
                    "Scale range must be exactly divisible by its step",
                    "minValue" to minValue,
                    "maxValue" to maxValue,
                    "stepValue" to stepValue,
                )
            }

            val maxTick = try {
                ticks[0].longValueExact()
            } catch (exception: ArithmeticException) {
                throw DomainException(
                    DomainErrorCode.INVALID_SCALE,
                    "Scale contains too many ticks",
                    mapOf("maxTick" to ticks[0].toPlainString()),
                    exception,
                )
            }
            return Scale(min, max, step, maxTick)
        }

        private fun String.toExactDecimal(field: String): BigDecimal = try {
            BigDecimal(this)
        } catch (exception: NumberFormatException) {
            throw DomainException(
                DomainErrorCode.INVALID_DECIMAL,
                "$field must be a decimal string",
                mapOf(field to this),
                exception,
            )
        }
    }

    fun isValidTick(tickIndex: Long): Boolean = tickIndex in 0..maxTick

    fun requireTick(tickIndex: Long) {
        if (!isValidTick(tickIndex)) {
            domainFailure(
                DomainErrorCode.INVALID_TICK_INDEX,
                "Tick index is outside the scale",
                "tickIndex" to tickIndex,
                "minTick" to 0,
                "maxTick" to maxTick,
            )
        }
    }

    fun display(tickIndex: Long): BigDecimal {
        requireTick(tickIndex)
        return minValue + stepValue.multiply(BigDecimal.valueOf(tickIndex))
    }

    fun displayString(tickIndex: Long): String = display(tickIndex).toCanonicalString()

    fun normalized(tickIndex: Long): BigDecimal {
        requireTick(tickIndex)
        return BigDecimal.valueOf(tickIndex).divide(BigDecimal.valueOf(maxTick), MathContext.DECIMAL128)
    }

    fun normalizedString(tickIndex: Long): String = normalized(tickIndex).toCanonicalString()

    fun minValueString(): String = minValue.toCanonicalString()

    fun maxValueString(): String = maxValue.toCanonicalString()

    fun stepValueString(): String = stepValue.toCanonicalString()

    override fun equals(other: Any?): Boolean = other is Scale &&
        minValue.compareTo(other.minValue) == 0 &&
        maxValue.compareTo(other.maxValue) == 0 &&
        stepValue.compareTo(other.stepValue) == 0

    override fun hashCode(): Int {
        var result = minValue.stripTrailingZeros().hashCode()
        result = 31 * result + maxValue.stripTrailingZeros().hashCode()
        result = 31 * result + stepValue.stripTrailingZeros().hashCode()
        return result
    }

    override fun toString(): String = "Scale(min=${minValueString()}, max=${maxValueString()}, step=${stepValueString()})"
}

private fun BigDecimal.toCanonicalString(): String = stripTrailingZeros().toPlainString()
