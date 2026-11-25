# Disposable Android build environment for the Nuzm mobile build engine (P3-S06, owner approval B-Android; sandbox-class isolation needs D-21/P3-S02 runtime).
# STATUS: RECIPE, NOT BUILT. This Mac has no Docker and no container runtime was approved; the recipe is the definition the Linux node (P3-S02) will build.
# Nothing here pulls an unpinned artifact silently: every download takes an expected SHA-256 as a REQUIRED build argument and fails if it does not match.
# The values of the digests are intentionally NOT written here: they must be copied from the official download pages by whoever builds the image (never invented by an agent).
#
#   docker build -f infra/mobile/android/Dockerfile \
#     --build-arg FLUTTER_SHA256=<sha256 of flutter_linux_3.35.7-stable.tar.xz> \
#     --build-arg JDK_URL=<Temurin 17 linux x64 tar.gz URL> --build-arg JDK_SHA256=<sha256> \
#     --build-arg CMDLINE_TOOLS_URL=<commandlinetools-linux-*_latest.zip URL> --build-arg CMDLINE_TOOLS_SHA256=<sha256> \
#     -t nuzm-android-build:3.35.7 .
#
# Run (network: only the registry mirror; no host mounts; read-only root; no capabilities; not privileged):
#   docker run --rm --network nuzm-build-net --read-only --tmpfs /tmp:rw,size=4g --tmpfs /home/nuzm-build:rw,size=12g,uid=10001 \
#     --cap-drop ALL --security-opt no-new-privileges --pids-limit 1024 --memory 8g --cpus 4 \
#     -e NUZM_REGISTRY_MIRROR -e PUB_HOSTED_URL -e FLUTTER_STORAGE_BASE_URL -e NUZM_MAVEN_MIRROR nuzm-android-build:3.35.7 <command>
FROM debian:12-slim AS base
ARG FLUTTER_VERSION=3.35.7
ARG FLUTTER_SHA256
ARG JDK_URL
ARG JDK_SHA256
ARG CMDLINE_TOOLS_URL
ARG CMDLINE_TOOLS_SHA256
ARG ANDROID_PLATFORMS="android-35 android-36"
ARG ANDROID_BUILD_TOOLS="35.0.0"
RUN test -n "$FLUTTER_SHA256" && test -n "$JDK_URL" && test -n "$JDK_SHA256" && test -n "$CMDLINE_TOOLS_URL" && test -n "$CMDLINE_TOOLS_SHA256" \
 || (echo "every download digest must be supplied as a build argument" >&2; exit 1)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip xz-utils git zip libglu1-mesa && rm -rf /var/lib/apt/lists/*
# dedicated unprivileged user; the build runs as it and holds nothing else
RUN useradd --uid 10001 --create-home --home-dir /home/nuzm-build --shell /usr/sbin/nologin nuzm-build
# Flutter (pinned, checksum verified)
RUN curl -fsSL -o /tmp/flutter.tar.xz "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz" \
 && echo "${FLUTTER_SHA256}  /tmp/flutter.tar.xz" | sha256sum -c - && tar -C /opt -xf /tmp/flutter.tar.xz && rm /tmp/flutter.tar.xz
# JDK 17 (pinned, checksum verified)
RUN curl -fsSL -o /tmp/jdk.tgz "${JDK_URL}" && echo "${JDK_SHA256}  /tmp/jdk.tgz" | sha256sum -c - && mkdir -p /opt/jdk && tar -C /opt/jdk --strip-components=1 -xf /tmp/jdk.tgz && rm /tmp/jdk.tgz
# Android command-line tools, then the pinned packages. SDK LICENCES: accepting them is a human decision (B-Android); the build argument below records that decision, it is never defaulted.
ARG ACCEPT_ANDROID_SDK_LICENSES=no
RUN curl -fsSL -o /tmp/cmdline.zip "${CMDLINE_TOOLS_URL}" && echo "${CMDLINE_TOOLS_SHA256}  /tmp/cmdline.zip" | sha256sum -c - \
 && mkdir -p /opt/android/cmdline-tools && unzip -q /tmp/cmdline.zip -d /opt/android/cmdline-tools && mv /opt/android/cmdline-tools/cmdline-tools /opt/android/cmdline-tools/latest && rm /tmp/cmdline.zip
ENV JAVA_HOME=/opt/jdk ANDROID_HOME=/opt/android ANDROID_SDK_ROOT=/opt/android FLUTTER_ROOT=/opt/flutter
ENV PATH=/opt/flutter/bin:/opt/jdk/bin:/opt/android/cmdline-tools/latest/bin:/opt/android/platform-tools:${PATH}
RUN test "$ACCEPT_ANDROID_SDK_LICENSES" = "yes" || (echo "set --build-arg ACCEPT_ANDROID_SDK_LICENSES=yes only after the owner accepted the Android SDK licences" >&2; exit 1)
RUN yes | sdkmanager --licenses >/dev/null && sdkmanager "platform-tools" "build-tools;${ANDROID_BUILD_TOOLS}" $(for p in ${ANDROID_PLATFORMS}; do printf '"platforms;%s" ' "$p"; done)
RUN chown -R nuzm-build:nuzm-build /opt/flutter /opt/android
# Mirrors: Gradle reaches only the mirror (init script), pub and Flutter engine storage are redirected by environment variables at run time.
COPY infra/mobile/android/gradle-init-mirror.gradle /opt/gradle-init/mirror.gradle
ENV FLUTTER_VERSION=${FLUTTER_VERSION}
ENV NUZM_BUILD_ENV=disposable NUZM_BUILD_ISOLATION=container NUZM_BUILD_USER=nuzm-build \
    HOME=/home/nuzm-build GRADLE_USER_HOME=/home/nuzm-build/.gradle PUB_CACHE=/home/nuzm-build/.pub-cache \
    FLUTTER_SUPPRESS_ANALYTICS=true CI=true
USER nuzm-build
# the pinned Flutter is verified at start; a different version is a refusal, not a warning
ENTRYPOINT ["/bin/sh", "-c", "mkdir -p $GRADLE_USER_HOME/init.d && cp /opt/gradle-init/mirror.gradle $GRADLE_USER_HOME/init.d/ && test \"$(flutter --version --machine | sed -n 's/.*\"frameworkVersion\": *\"\\([^\"]*\\)\".*/\\1/p')\" = \"$FLUTTER_VERSION\" && exec \"$@\"", "--"]
