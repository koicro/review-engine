package dev.reviewengine.persistence

import dev.reviewengine.domain.Category
import dev.reviewengine.domain.Criterion
import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import dev.reviewengine.domain.Entity
import dev.reviewengine.domain.EntityRelation
import dev.reviewengine.domain.RelationType
import dev.reviewengine.domain.Review
import dev.reviewengine.domain.ReviewStatus
import dev.reviewengine.domain.Scale
import dev.reviewengine.domain.Score
import dev.reviewengine.domain.TemplateCriterion
import dev.reviewengine.domain.TemplateStatus
import dev.reviewengine.domain.TemplateVersion
import java.time.Instant
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class RepositoriesTest {
    private val now = Instant.parse("2026-08-13T00:00:00Z")

    @Test
    fun `publishing draft atomically installs active category template`() {
        withDatabase { database, repositories, fixture ->
            database.write { connection ->
                val published = repositories.templates.publish(connection, fixture.templateId, 0, now.plusSeconds(1))
                assertEquals(TemplateStatus.PUBLISHED, published.status)
            }

            database.read { connection ->
                assertEquals(fixture.templateId, repositories.categories.getById(connection, fixture.categoryId).activeTemplateVersionId)
                assertEquals(fixture.templateId, repositories.templates.findActiveForCategory(connection, fixture.categoryId)?.version?.id)
            }
        }
    }

    @Test
    fun `finalizing a review validates required ticks and persists scores`() {
        withDatabase { database, repositories, fixture ->
            database.write { connection -> repositories.templates.publish(connection, fixture.templateId, 0, now) }
            val reviewId = UUID.randomUUID()
            database.write { connection ->
                repositories.reviews.insert(
                    connection,
                    Review(
                        id = reviewId,
                        entityId = fixture.firstEntityId,
                        reviewerId = DefaultReviewer.ID,
                        templateVersionId = fixture.templateId,
                        reviewedAt = now,
                        status = ReviewStatus.DRAFT,
                        createdAt = now,
                        updatedAt = now,
                    ),
                )
            }

            val missing = assertFailsWith<DomainException> {
                database.write { connection ->
                    repositories.reviews.finalize(connection, reviewId, 0, emptyList(), now.plusSeconds(1))
                }
            }
            assertEquals(DomainErrorCode.REQUIRED_SCORE_MISSING, missing.code)

            database.write { connection ->
                repositories.reviews.finalize(
                    connection,
                    reviewId,
                    0,
                    listOf(Score(reviewId, fixture.criterionId, 4)),
                    now.plusSeconds(1),
                )
            }
            database.read { connection ->
                val stored = repositories.reviews.getWithScores(connection, reviewId)
                assertEquals(ReviewStatus.FINAL, stored.review.status)
                assertEquals(4L, stored.scores.single().tickIndex)
            }
        }
    }

    @Test
    fun `hierarchical relation rejects a cycle while non hierarchical type permits one`() {
        withDatabase { database, repositories, fixture ->
            database.write { connection ->
                val hierarchy = RelationType(UUID.randomUUID(), "parent", "parent of", "child of", true, now)
                repositories.relations.insertType(connection, hierarchy)
                repositories.relations.insertRelation(
                    connection,
                    EntityRelation(UUID.randomUUID(), fixture.firstEntityId, fixture.secondEntityId, hierarchy.id, now),
                )
                val failure = assertFailsWith<DomainException> {
                    repositories.relations.insertRelation(
                        connection,
                        EntityRelation(UUID.randomUUID(), fixture.secondEntityId, fixture.firstEntityId, hierarchy.id, now),
                    )
                }
                assertEquals(DomainErrorCode.HIERARCHY_CYCLE, failure.code)

                val peer = RelationType(UUID.randomUUID(), "peer", "peer", "peer", false, now)
                repositories.relations.insertType(connection, peer)
                repositories.relations.insertRelation(
                    connection,
                    EntityRelation(UUID.randomUUID(), fixture.firstEntityId, fixture.secondEntityId, peer.id, now),
                )
                repositories.relations.insertRelation(
                    connection,
                    EntityRelation(UUID.randomUUID(), fixture.secondEntityId, fixture.firstEntityId, peer.id, now),
                )
            }
        }
    }

    private fun withDatabase(block: (Database, Repositories, Fixture) -> Unit) {
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            val repositories = Repositories()
            val categoryId = UUID.randomUUID()
            val templateId = UUID.randomUUID()
            val criterionId = UUID.randomUUID()
            val firstEntityId = UUID.randomUUID()
            val secondEntityId = UUID.randomUUID()
            database.write { connection ->
                repositories.categories.insert(
                    connection,
                    Category(categoryId, "Coffee", createdAt = now, updatedAt = now),
                )
                repositories.templates.insertVersion(
                    connection,
                    TemplateVersion(templateId, categoryId, 1, TemplateStatus.DRAFT, createdAt = now, updatedAt = now),
                )
                repositories.templates.insertCriterion(connection, Criterion(criterionId, categoryId, now))
                repositories.templates.insertTemplateCriterion(
                    connection,
                    TemplateCriterion(
                        templateVersionId = templateId,
                        criterionId = criterionId,
                        name = "Taste",
                        scale = Scale.of(maxValue = "5", stepValue = "1"),
                        position = 0,
                        required = true,
                    ),
                )
                repositories.entities.insert(
                    connection,
                    Entity(firstEntityId, categoryId, "First", createdAt = now, updatedAt = now),
                )
                repositories.entities.insert(
                    connection,
                    Entity(secondEntityId, categoryId, "Second", createdAt = now, updatedAt = now),
                )
            }
            block(database, repositories, Fixture(categoryId, templateId, criterionId, firstEntityId, secondEntityId))
        }
    }

    private data class Fixture(
        val categoryId: UUID,
        val templateId: UUID,
        val criterionId: UUID,
        val firstEntityId: UUID,
        val secondEntityId: UUID,
    )
}
