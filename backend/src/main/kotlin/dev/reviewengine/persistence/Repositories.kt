package dev.reviewengine.persistence

/** Stateless JDBC data-access helpers. Pass them a connection from [Database.read] or [Database.write]. */
class Repositories(
    val categories: CategoryRepository = CategoryRepository(),
    val templates: TemplateRepository = TemplateRepository(),
    val entities: EntityRepository = EntityRepository(),
    val reviewers: ReviewerRepository = ReviewerRepository(),
    val reviews: ReviewRepository = ReviewRepository(templates),
    val relations: RelationRepository = RelationRepository(),
    val accessTokens: AccessTokenRepository = AccessTokenRepository(),
    val webSessions: WebSessionRepository = WebSessionRepository(),
)
