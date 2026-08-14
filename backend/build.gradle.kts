import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    application
    kotlin("jvm")
    kotlin("plugin.serialization")
    id("io.ktor.plugin")
}

val ktorVersion = "3.5.1"
val sqliteJdbcVersion = "3.53.1.0"
val serializationVersion = "1.9.0"
val logbackVersion = "1.5.18"
val junitVersion = "5.13.4"

application {
    mainClass.set("dev.reviewengine.api.MainKt")
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
        freeCompilerArgs.add("-Xjsr305=strict")
    }
}

dependencies {
    implementation(platform("io.ktor:ktor-bom:$ktorVersion"))
    implementation("io.ktor:ktor-server-core-jvm")
    implementation("io.ktor:ktor-server-netty-jvm")
    implementation("io.ktor:ktor-server-content-negotiation-jvm")
    implementation("io.ktor:ktor-serialization-kotlinx-json-jvm")
    implementation("io.ktor:ktor-server-status-pages-jvm")
    implementation("io.ktor:ktor-server-call-logging-jvm")
    implementation("io.ktor:ktor-server-cors-jvm")
    implementation("io.ktor:ktor-server-auth-jvm")
    implementation("io.ktor:ktor-server-default-headers-jvm")
    implementation("io.ktor:ktor-server-body-limit-jvm")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:$serializationVersion")
    implementation("org.xerial:sqlite-jdbc:$sqliteJdbcVersion")
    implementation("ch.qos.logback:logback-classic:$logbackVersion")

    testImplementation(kotlin("test-junit5"))
    testImplementation(platform("io.ktor:ktor-bom:$ktorVersion"))
    testImplementation(platform("org.junit:junit-bom:$junitVersion"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("io.ktor:ktor-server-test-host-jvm")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
}

tasks.withType<AbstractArchiveTask>().configureEach {
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}

ktor {
    fatJar {
        archiveFileName.set("review-engine.jar")
    }
}
