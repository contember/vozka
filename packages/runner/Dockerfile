# vozka CI runner image.
#
# Bakes in the (unpublished) vozka deploy toolchain — @vozka/config + @vozka/core (the `vozka`
# CLI) + @vozka/runner (the in-container server) — alongside git, node, bun and wrangler, so a
# spawned container can clone a target app, `bun install` it, and run `vozka deploy` against its
# config.
#
# BUILD CONTEXT = the vozka repo ROOT (so we can copy the workspace packages). Run via
# `bun run docker:build` (from packages/runner), which first vendors a fresh oblaka tarball
# (see docker/prepare.ts) and then:
# docker build -f packages/runner/Dockerfile -t vozka-runner <repo-root>
#
# oblaka-iac is installed from that vendored tarball (docker/vendor/), NOT from npm: the published
# oblaka-iac predates the programmatic `deploy()` the M1 engine calls. @propustka/* resolve from npm.

FROM ubuntu:24.04

# Toolchain: git (clone), ca-certificates (HTTPS), curl + unzip (bun installer), bash.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		git \
		ca-certificates \
		curl \
		unzip \
		bash \
	&& rm -rf /var/lib/apt/lists/*

# Node 22+ — wrangler's CLI shebang is `#!/usr/bin/env node` and it requires Node >= 22.
# (Ubuntu 24.04's apt nodejs is v18, too old.)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
	&& apt-get install -y --no-install-recommends nodejs \
	&& rm -rf /var/lib/apt/lists/*

# bun — both the runner's own runtime and the tool that installs target apps.
RUN curl -fsSL https://bun.com/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# wrangler on PATH globally: the deploy step shells out to a bare `wrangler` (deploy-worker /
# d1 migrations / secret put) with cwd = the target repo, so it must resolve regardless of cwd.
RUN bun install -g wrangler@4

WORKDIR /opt/vozka

# A self-contained workspace: just the three packages the runner needs at runtime, plus the
# vendored oblaka tarball. `bun install` resolves oblaka-iac from the tarball and @propustka/* +
# wrangler from npm.
COPY packages/runner/docker/package.json ./package.json
COPY packages/runner/docker/vendor ./vendor
COPY packages/config ./packages/config
COPY packages/core ./packages/core
COPY packages/runner/src ./packages/runner/src
COPY packages/runner/package.json ./packages/runner/package.json

RUN bun install

# Expose the `vozka` CLI on PATH (it's the bin of @vozka/core, run via bun).
RUN printf '#!/usr/bin/env bash\nexec bun /opt/vozka/packages/core/src/cli.ts "$@"\n' > /usr/local/bin/vozka \
	&& chmod +x /usr/local/bin/vozka

# Where target repos are cloned. The runner server creates one sub-dir per run.
ENV VOZKA_WORKSPACE=/workspace
RUN mkdir -p /workspace

EXPOSE 8080

ENTRYPOINT ["bun", "/opt/vozka/packages/runner/src/serve.ts"]
