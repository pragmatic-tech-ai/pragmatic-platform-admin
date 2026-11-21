# syntax=docker/dockerfile:1
# pragmatic-platform-admin: one image, built from this repository alone; every @pragmatic-tech-ai package comes from GitHub Packages
# through the lock (no sibling checkout). Rendered by pragmatic-container-template (@pragmatic-tech-ai/pragmatic-release-toolkit).
# The image carries its component descriptor at /pragmatic/component.json and the descriptor's digest as the label
# ai.pragmatic-tech.component.digest. Build in two steps (docker-bake.hcl): `components` exports the descriptor, its
# digest and the bake override that hands the image target its COMPONENT_APP and COMPONENT_DIGEST, then the image:
#   NPMRC_FILE=$HOME/.npmrc docker buildx bake -f docker-bake.hcl --allow=fs.read=$HOME/.npmrc components
#   NPMRC_FILE=$HOME/.npmrc VERSION=0.1.0 GIT_SHA=$(git rev-parse HEAD) docker buildx bake -f docker-bake.hcl \
#     -f .components/docker-bake.components.json --allow=fs.read=$HOME/.npmrc pragmatic-platform-admin
# NPMRC_FILE names an .npmrc able to read @pragmatic-tech-ai packages; it reaches the build only as the BuildKit secret
# `npmrc`, never as an ARG, an ENV or a layer (.dockerignore keeps the repository's own .npmrc out of the context).
# The image paths sit under /workspace/pragmatic-platform-admin, the layout pragmatic-closure-check reads this file with.

FROM node:22@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb AS deps
WORKDIR /workspace/pragmatic-platform-admin
# Native addons (lmdb, where an app reaches it) need a C toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
# The manifests and the lock first, so the install layer is reused while they do not change.
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    npm ci --no-audit --no-fund

FROM deps AS compile
COPY . .
RUN npm run build
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    cd portal && npm ci --no-audit --no-fund && npm run build && rm -rf node_modules
# closure.json, this Dockerfile and the code must agree (package.json `pragmaticClosureCheck`), checked on the very tree
# the image is cut from.
RUN ./node_modules/.bin/pragmatic-closure-check

# The component descriptor, from the repository's descriptor class: dist/release-components.js exports `Components`, an
# IReleaseComponentSource of this one app (ContainerComponentSource). `component-set` writes it with its digest and the
# bake override; the `components` bake target exports them before the image is baked, since a label value must be known
# when the build starts.
FROM compile AS component-set
RUN ./node_modules/.bin/pragmatic-component-descriptors --components dist/release-components.js emit-all --out /components

FROM scratch AS components
COPY --from=component-set /components /

# The descriptor the image carries: the CLI refuses one whose digest is not COMPONENT_DIGEST (the label value), and the
# bytes written are hashed once more, so /pragmatic/component.json and the label always agree. A build without the
# override stops here.
FROM compile AS component
ARG COMPONENT_APP
ARG COMPONENT_DIGEST
RUN [ "$COMPONENT_APP" = "pragmatic-platform-admin" ] \
    || { echo "COMPONENT_APP is not pragmatic-platform-admin: bake with the .components/docker-bake.components.json override" >&2; exit 1; }
RUN ./node_modules/.bin/pragmatic-component-descriptors --components dist/release-components.js emit --app "pragmatic-platform-admin" --digest "$COMPONENT_DIGEST" --out /component/component.json
RUN [ "sha256:$(sha256sum /component/component.json | cut -d ' ' -f 1)" = "$COMPONENT_DIGEST" ] \
    || { echo "component descriptor digest mismatch: bake with the .components/docker-bake.components.json override" >&2; exit 1; }

# Production dependencies only; source maps and build info dropped.
FROM compile AS build
# Kept across the prune: esbuild @esbuild typescript, dev dependencies the runtime imports (TODL loads esbuild and typescript at
# module load), stashed before it and restored after it.
RUN set -e; mkdir /runtime-dev-stash; \
    for pkg in esbuild @esbuild typescript; do cp -a "node_modules/$pkg" "/runtime-dev-stash/$pkg"; done; \
    npm prune --omit=dev --no-audit --no-fund; \
    for pkg in esbuild @esbuild typescript; do rm -rf "node_modules/$pkg"; cp -a "/runtime-dev-stash/$pkg" "node_modules/$pkg"; done; \
    rm -rf /runtime-dev-stash; \
    find . -type f \( -name '*.map' -o -name '*.tsbuildinfo' \) -delete

# The provisioning CLIs the admin drives remote targets with (spec D26): kubectl, kind and the docker CLI (client only;
# no daemon runs in or next to admin). Each download is checked against a pinned sha256 for the build's TARGETARCH.
# Upstream checksums: dl.k8s.io/release/<v>/bin/linux/<arch>/kubectl.sha256 and the kind release's
# kind-linux-<arch>.sha256sum. download.docker.com publishes no checksums for the static bundles, so those two are pinned
# from a verified download (2026-11-19).
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS platform-admin-tools
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.37.2
ARG KUBECTL_SHA256_AMD64=c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4
ARG KUBECTL_SHA256_ARM64=fcc16f63186659d9722014b7e02d5fdd2d4e669cb8c0ab66365d7d3b8ba03509
ARG KIND_VERSION=v0.33.0
ARG KIND_SHA256_AMD64=aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d
ARG KIND_SHA256_ARM64=20022bee6cfcd5086cb7234d218e3454e6090022f2a8f55d1fa7fcf42c3867a2
ARG DOCKER_VERSION=29.10.0
ARG DOCKER_SHA256_AMD64=7c1ebadc65c716cdc6d35fc78759ed0e4317debf43c21dd12f066f2006999def
ARG DOCKER_SHA256_ARM64=6e5159e8b5615e0c0c2954a2a1a2a12bc65f5d9b603595dba24a10cb367408cd
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) K="$KUBECTL_SHA256_AMD64"; I="$KIND_SHA256_AMD64"; D="$DOCKER_SHA256_AMD64"; DA=x86_64 ;; \
      arm64) K="$KUBECTL_SHA256_ARM64"; I="$KIND_SHA256_ARM64"; D="$DOCKER_SHA256_ARM64"; DA=aarch64 ;; \
      *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    mkdir -p /tools && cd /tools; \
    curl -fsSL -o kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl"; \
    echo "$K  kubectl" | sha256sum -c -; \
    curl -fsSL -o kind "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-linux-${TARGETARCH}"; \
    echo "$I  kind" | sha256sum -c -; \
    curl -fsSL -o docker.tgz "https://download.docker.com/linux/static/stable/${DA}/docker-${DOCKER_VERSION}.tgz"; \
    echo "$D  docker.tgz" | sha256sum -c -; \
    tar -xzf docker.tgz docker/docker && mv docker/docker ./docker-cli && rm -rf docker docker.tgz; \
    chmod 0755 kubectl kind docker-cli

FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime
ENV NODE_ENV=production
# uid and gid are both 10001, so the --chown=10001:10001 copies below never leave files under an orphan group.
RUN groupadd --system --gid 10001 pragmatic && useradd --system --create-home --uid 10001 --gid 10001 pragmatic
WORKDIR /workspace/pragmatic-platform-admin

FROM runtime AS pragmatic-platform-admin
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=platform-admin-tools /tools/kubectl /usr/local/bin/kubectl
COPY --from=platform-admin-tools /tools/kind /usr/local/bin/kind
COPY --from=platform-admin-tools /tools/docker-cli /usr/local/bin/docker
COPY --from=build --chown=10001:10001 /workspace/pragmatic-platform-admin/package.json /workspace/pragmatic-platform-admin/package.json
COPY --from=build --chown=10001:10001 /workspace/pragmatic-platform-admin/node_modules /workspace/pragmatic-platform-admin/node_modules
COPY --from=build --chown=10001:10001 /workspace/pragmatic-platform-admin/dist /workspace/pragmatic-platform-admin/dist
COPY --from=build --chown=10001:10001 /workspace/pragmatic-platform-admin/portal/dist /workspace/pragmatic-platform-admin/portal/dist
COPY --from=build --chown=10001:10001 /workspace/pragmatic-platform-admin/release-keys /workspace/pragmatic-platform-admin/release-keys
ENV PRAGMATIC_CONTROL_PLANE_ROLE=admin
ARG COMPONENT_DIGEST
COPY --from=component /component/component.json /pragmatic/component.json
LABEL ai.pragmatic-tech.component.digest=$COMPONENT_DIGEST
USER 10001
EXPOSE 7000 7001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const r=require('node:http').request({host:'127.0.0.1',port:process.env.PRAGMATIC_ADMIN_PORT||7000,path:'/healthz'},x=>process.exit(x.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.end()"
ENTRYPOINT ["node", "dist/server.js"]
