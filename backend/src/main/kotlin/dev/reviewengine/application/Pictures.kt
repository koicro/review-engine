package dev.reviewengine.application

import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import dev.reviewengine.domain.DomainRules
import dev.reviewengine.domain.ReviewPicture
import dev.reviewengine.persistence.setInstant
import dev.reviewengine.persistence.toDatabaseTimestamp
import java.io.FilterOutputStream
import java.io.OutputStream
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.sql.Connection
import java.time.Instant
import java.util.UUID
import org.slf4j.LoggerFactory

const val MAX_PICTURES_PER_REVIEW: Int = 3
const val MAX_PICTURE_SIZE_BYTES: Long = 100_000_000L
const val MAX_PICTURE_FILE_NAME_CHARS: Int = 255

internal data class StagedPicture(
    val path: Path,
    val fileName: String,
    val contentType: String,
    val sizeBytes: Long,
    val extension: String,
)

data class PictureContent(
    val picture: ReviewPicture,
    val path: Path,
)

class PictureStorage(
    private val root: Path,
    private val maximumPictureSizeBytes: Long = MAX_PICTURE_SIZE_BYTES,
) {
    private val normalizedRoot = root.toAbsolutePath().normalize()

    init {
        require(maximumPictureSizeBytes in 1..MAX_PICTURE_SIZE_BYTES) {
            "Picture size limit must be between 1 and $MAX_PICTURE_SIZE_BYTES bytes"
        }
    }

    internal fun initialize() {
        Files.createDirectories(normalizedRoot)
        require(Files.isDirectory(normalizedRoot)) { "Picture storage path must be a directory" }
    }

    internal suspend fun stage(fileName: String?, transfer: suspend (OutputStream) -> Unit): StagedPicture {
        initialize()
        val safeName = sanitizeFileName(fileName)
        val temporary = Files.createTempFile(normalizedRoot, ".upload-", ".tmp")
        return try {
            val limited = LimitedOutputStream(Files.newOutputStream(temporary), maximumPictureSizeBytes)
            limited.use { transfer(it) }
            val mediaType = detectPictureType(temporary)
                ?: throw DomainException(
                    DomainErrorCode.UNSUPPORTED_PICTURE_TYPE,
                    "Only JPEG, PNG, WebP, and GIF pictures are supported",
                    mapOf("fileName" to safeName),
                )
            StagedPicture(
                path = temporary,
                fileName = safeName,
                contentType = mediaType.contentType,
                sizeBytes = limited.bytesWritten,
                extension = mediaType.extension,
            )
        } catch (failure: Throwable) {
            Files.deleteIfExists(temporary)
            throw failure
        }
    }

    internal fun commit(staged: StagedPicture, pictureId: UUID): String {
        val storageKey = "$pictureId.${staged.extension}"
        val target = resolveStorageKey(storageKey)
        try {
            Files.move(staged.path, target, StandardCopyOption.ATOMIC_MOVE)
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(staged.path, target)
        }
        return storageKey
    }

    internal fun discard(staged: StagedPicture) {
        runCatching { Files.deleteIfExists(staged.path) }
            .onFailure { logger.warn("Could not discard staged picture {}", staged.path.fileName, it) }
    }

    internal fun delete(storageKey: String) {
        runCatching { Files.deleteIfExists(resolveStorageKey(storageKey)) }
            .onFailure { logger.warn("Could not delete unreferenced picture {}", storageKey, it) }
    }

    internal fun contentPath(storageKey: String): Path {
        val path = resolveStorageKey(storageKey)
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            throw DomainException(
                DomainErrorCode.CONFLICT,
                "Picture content is unavailable",
                mapOf("storageKey" to storageKey),
            )
        }
        return path
    }

    private fun resolveStorageKey(storageKey: String): Path {
        if (!STORAGE_KEY.matches(storageKey)) {
            throw DomainException(DomainErrorCode.CONFLICT, "Picture storage metadata is invalid")
        }
        val resolved = normalizedRoot.resolve(storageKey).normalize()
        if (resolved.parent != normalizedRoot) {
            throw DomainException(DomainErrorCode.CONFLICT, "Picture storage metadata is invalid")
        }
        return resolved
    }

    companion object {
        fun default(): PictureStorage = PictureStorage(Path.of("./data/review-pictures"))

        private val STORAGE_KEY = Regex("[0-9a-fA-F-]{36}\\.(jpg|png|webp|gif)")
        private val logger = LoggerFactory.getLogger(PictureStorage::class.java)
    }
}

internal suspend fun ReviewEngine.stagePicture(
    fileName: String?,
    transfer: suspend (OutputStream) -> Unit,
): StagedPicture = pictureStorage.stage(fileName, transfer)

internal fun ReviewEngine.discardPictures(pictures: Iterable<StagedPicture>) {
    pictures.forEach(pictureStorage::discard)
}

internal fun ReviewEngine.availableReviewPictureSlots(reviewId: UUID, expectedLockVersion: Long): Int =
    database.read { connection ->
        val review = connection.review(reviewId)
        DomainRules.requireReviewEditable(review)
        if (review.lockVersion != expectedLockVersion) {
            optimisticConflict("Review", reviewId, expectedLockVersion, review.lockVersion)
        }
        MAX_PICTURES_PER_REVIEW - connection.reviewPicturePositions(reviewId).size
    }

internal fun ReviewEngine.addReviewPictures(
    reviewId: UUID,
    expectedLockVersion: Long,
    stagedPictures: List<StagedPicture>,
): ReviewSnapshot {
    if (stagedPictures.isEmpty()) {
        throw DomainException(DomainErrorCode.INVALID_ARGUMENT, "At least one picture is required")
    }
    if (stagedPictures.size > MAX_PICTURES_PER_REVIEW) {
        throw DomainException(
            DomainErrorCode.PICTURE_LIMIT_EXCEEDED,
            "A review can contain at most $MAX_PICTURES_PER_REVIEW pictures",
        )
    }

    val committedKeys = mutableListOf<String>()
    return try {
        mapSqlConflict {
            database.write { connection ->
                val review = connection.review(reviewId)
                DomainRules.requireReviewEditable(review)
                if (review.lockVersion != expectedLockVersion) {
                    optimisticConflict("Review", reviewId, expectedLockVersion, review.lockVersion)
                }
                val existingPositions = connection.reviewPicturePositions(reviewId)
                if (existingPositions.size + stagedPictures.size > MAX_PICTURES_PER_REVIEW) {
                    throw DomainException(
                        DomainErrorCode.PICTURE_LIMIT_EXCEEDED,
                        "A review can contain at most $MAX_PICTURES_PER_REVIEW pictures",
                        mapOf("reviewId" to reviewId.toString(), "maximum" to MAX_PICTURES_PER_REVIEW.toString()),
                    )
                }
                val availablePositions = (0 until MAX_PICTURES_PER_REVIEW).filterNot(existingPositions::contains)
                val createdAt = now()
                stagedPictures.forEachIndexed { index, staged ->
                    val pictureId = newId()
                    val storageKey = pictureStorage.commit(staged, pictureId)
                    committedKeys += storageKey
                    connection.insertPictureAsset(pictureId, staged, storageKey, createdAt)
                    connection.linkPicture(reviewId, pictureId, availablePositions[index])
                }
                connection.bumpDraftReview(reviewId, expectedLockVersion, createdAt)
                reviewSnapshot(connection, connection.review(reviewId))
            }
        }
    } catch (failure: Throwable) {
        committedKeys.forEach(pictureStorage::delete)
        throw failure
    } finally {
        discardPictures(stagedPictures)
    }
}

fun ReviewEngine.getReviewPicture(reviewId: UUID, pictureId: UUID): PictureContent = database.read { connection ->
    connection.review(reviewId)
    val picture = connection.reviewPicture(reviewId, pictureId)
    PictureContent(picture, pictureStorage.contentPath(picture.storageKey))
}

fun ReviewEngine.deleteReviewPicture(
    reviewId: UUID,
    pictureId: UUID,
    expectedLockVersion: Long,
): ReviewSnapshot {
    var unreferencedStorageKey: String? = null
    val snapshot = mapSqlConflict {
        database.write { connection ->
            val review = connection.review(reviewId)
            DomainRules.requireReviewEditable(review)
            if (review.lockVersion != expectedLockVersion) {
                optimisticConflict("Review", reviewId, expectedLockVersion, review.lockVersion)
            }
            val picture = connection.reviewPicture(reviewId, pictureId)
            connection.prepareStatement(
                "DELETE FROM review_picture WHERE review_id = ? AND picture_id = ?",
            ).use { statement ->
                statement.setString(1, reviewId.toString())
                statement.setString(2, pictureId.toString())
                if (statement.executeUpdate() != 1) notFound("Picture", pictureId)
            }
            if (connection.pictureReferenceCount(pictureId) == 0L) {
                connection.prepareStatement("DELETE FROM picture_asset WHERE id = ?").use { statement ->
                    statement.setString(1, pictureId.toString())
                    statement.executeUpdate()
                }
                unreferencedStorageKey = picture.storageKey
            }
            val changedAt = now()
            connection.bumpDraftReview(reviewId, expectedLockVersion, changedAt)
            reviewSnapshot(connection, connection.review(reviewId))
        }
    }
    unreferencedStorageKey?.let(pictureStorage::delete)
    return snapshot
}

internal fun Connection.copyReviewPictures(sourceReviewId: UUID, targetReviewId: UUID) {
    prepareStatement(
        """
        INSERT INTO review_picture(review_id, picture_id, position)
        SELECT ?, picture_id, position FROM review_picture WHERE review_id = ?
        ORDER BY position
        """.trimIndent(),
    ).use { statement ->
        statement.setString(1, targetReviewId.toString())
        statement.setString(2, sourceReviewId.toString())
        statement.executeUpdate()
    }
}

internal fun Connection.deleteOrphanedPictureAssets(reviewId: UUID): List<String> {
    val candidates = prepareStatement(
        """
        SELECT pa.id, pa.storage_key
        FROM review_picture rp JOIN picture_asset pa ON pa.id = rp.picture_id
        WHERE rp.review_id = ?
        """.trimIndent(),
    ).use { statement ->
        statement.setString(1, reviewId.toString())
        statement.executeQuery().use { result ->
            buildList { while (result.next()) add(UUID.fromString(result.getString(1)) to result.getString(2)) }
        }
    }
    prepareStatement("DELETE FROM review_picture WHERE review_id = ?").use { statement ->
        statement.setString(1, reviewId.toString())
        statement.executeUpdate()
    }
    return candidates.mapNotNull { (pictureId, storageKey) ->
        if (pictureReferenceCount(pictureId) == 0L) {
            prepareStatement("DELETE FROM picture_asset WHERE id = ?").use { statement ->
                statement.setString(1, pictureId.toString())
                statement.executeUpdate()
            }
            storageKey
        } else {
            null
        }
    }
}

private fun Connection.insertPictureAsset(
    pictureId: UUID,
    staged: StagedPicture,
    storageKey: String,
    createdAt: Instant,
) {
    prepareStatement(
        """
        INSERT INTO picture_asset(id, file_name, content_type, size_bytes, storage_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """.trimIndent(),
    ).use { statement ->
        statement.setString(1, pictureId.toString())
        statement.setString(2, staged.fileName)
        statement.setString(3, staged.contentType)
        statement.setLong(4, staged.sizeBytes)
        statement.setString(5, storageKey)
        statement.setInstant(6, createdAt)
        statement.executeUpdate()
    }
}

private fun Connection.linkPicture(reviewId: UUID, pictureId: UUID, position: Int) {
    prepareStatement("INSERT INTO review_picture(review_id, picture_id, position) VALUES (?, ?, ?)").use { statement ->
        statement.setString(1, reviewId.toString())
        statement.setString(2, pictureId.toString())
        statement.setInt(3, position)
        statement.executeUpdate()
    }
}

private fun Connection.reviewPicturePositions(reviewId: UUID): Set<Int> = prepareStatement(
    "SELECT position FROM review_picture WHERE review_id = ?",
).use { statement ->
    statement.setString(1, reviewId.toString())
    statement.executeQuery().use { result -> buildSet { while (result.next()) add(result.getInt(1)) } }
}

private fun Connection.reviewPicture(reviewId: UUID, pictureId: UUID): ReviewPicture = prepareStatement(
    """
    SELECT pa.* FROM review_picture rp
    JOIN picture_asset pa ON pa.id = rp.picture_id
    WHERE rp.review_id = ? AND rp.picture_id = ?
    """.trimIndent(),
).use { statement ->
    statement.setString(1, reviewId.toString())
    statement.setString(2, pictureId.toString())
    statement.executeQuery().use { result ->
        if (!result.next()) notFound("Picture", pictureId)
        result.toReviewPicture()
    }
}

private fun Connection.pictureReferenceCount(pictureId: UUID): Long = prepareStatement(
    "SELECT COUNT(*) FROM review_picture WHERE picture_id = ?",
).use { statement ->
    statement.setString(1, pictureId.toString())
    statement.executeQuery().use { result -> result.next(); result.getLong(1) }
}

private fun Connection.bumpDraftReview(reviewId: UUID, expectedLockVersion: Long, changedAt: Instant) {
    prepareStatement(
        """
        UPDATE review SET updated_at = ?, lock_version = lock_version + 1
        WHERE id = ? AND status = 'draft' AND lock_version = ?
        """.trimIndent(),
    ).use { statement ->
        statement.setString(1, changedAt.toDatabaseTimestamp())
        statement.setString(2, reviewId.toString())
        statement.setLong(3, expectedLockVersion)
        if (statement.executeUpdate() != 1) optimisticConflict("Review", reviewId, expectedLockVersion, null)
    }
}

internal fun java.sql.ResultSet.toReviewPicture() = ReviewPicture(
    id = UUID.fromString(getString("id")),
    fileName = getString("file_name"),
    contentType = getString("content_type"),
    sizeBytes = getLong("size_bytes"),
    storageKey = getString("storage_key"),
    createdAt = Instant.parse(getString("created_at")),
)

private fun sanitizeFileName(value: String?): String {
    val leaf = value.orEmpty().substringAfterLast('/').substringAfterLast('\\')
    val sanitized = leaf.map { character -> if (character.isISOControl()) '_' else character }
        .joinToString("")
        .trim()
    if (sanitized.isBlank()) return "picture"
    val end = sanitized.offsetByCodePoints(
        0,
        sanitized.codePointCount(0, sanitized.length).coerceAtMost(MAX_PICTURE_FILE_NAME_CHARS),
    )
    return sanitized.substring(0, end)
}

private data class PictureMediaType(val contentType: String, val extension: String)

private fun detectPictureType(path: Path): PictureMediaType? {
    val header = ByteArray(12)
    val read = Files.newInputStream(path).use { it.read(header) }
    if (read >= 3 && header[0] == 0xff.toByte() && header[1] == 0xd8.toByte() && header[2] == 0xff.toByte()) {
        return PictureMediaType("image/jpeg", "jpg")
    }
    if (
        read >= 8 && header.copyOfRange(0, 8).contentEquals(
            byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
        )
    ) {
        return PictureMediaType("image/png", "png")
    }
    if (read >= 6) {
        val signature = header.copyOfRange(0, 6).toString(Charsets.US_ASCII)
        if (signature == "GIF87a" || signature == "GIF89a") return PictureMediaType("image/gif", "gif")
    }
    if (
        read >= 12 &&
        header.copyOfRange(0, 4).toString(Charsets.US_ASCII) == "RIFF" &&
        header.copyOfRange(8, 12).toString(Charsets.US_ASCII) == "WEBP"
    ) {
        return PictureMediaType("image/webp", "webp")
    }
    return null
}

internal class LimitedOutputStream(delegate: OutputStream, private val maximum: Long) : FilterOutputStream(delegate) {
    var bytesWritten: Long = 0
        private set

    override fun write(value: Int) {
        requireCapacity(1)
        out.write(value)
        bytesWritten++
    }

    override fun write(buffer: ByteArray, offset: Int, length: Int) {
        requireCapacity(length)
        out.write(buffer, offset, length)
        bytesWritten += length
    }

    private fun requireCapacity(additional: Int) {
        if (bytesWritten + additional > maximum) {
            throw DomainException(
                DomainErrorCode.PAYLOAD_TOO_LARGE,
                "Each picture must be at most $maximum bytes",
                mapOf("maximumBytes" to maximum.toString()),
            )
        }
    }
}
