plugins {
    base
    kotlin("jvm") version "2.3.20" apply false
    kotlin("plugin.serialization") version "2.3.20" apply false
    id("io.ktor.plugin") version "3.5.1" apply false
}

allprojects {
    group = "dev.reviewengine"
    version = rootProject.providers
        .gradleProperty("projectVersion")
        .orElse("0.1.0-SNAPSHOT")
        .get()
}

tasks.named("check") {
    dependsOn(":backend:check")
}
