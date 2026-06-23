# vozka CI runner image.
#
# Bakes in the (unpublished) vozka deploy toolchain — vozka-config + @vozka/core (the `vozka`
# CLI) + @vozka/runner (the in-container server) — alongside git, node, bun and wrangler, so a
# spawned container can clone a target app, `bun install` it, and run `vozka deploy` against its
# config.
#
# BUILD CONTEXT = the vozka repo ROOT (so we can copy the workspace packages). Run via
# `bun run docker:build` (from packages/runner):
# docker build -f packages/runner/Dockerfile -t vozka-runner <repo-root>
#
# oblaka-iac, @propustka/* and wrangler all resolve from npm; oblaka-iac is pinned (docker/package.json)
# to the version that ships the programmatic `deploy()` the engine calls.

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
# Pinned to match the version @vozka/core + vozka-config build against (no version skew at deploy).
RUN bun install -g wrangler@4.72.0

WORKDIR /opt/vozka

# A self-contained workspace: just the three packages the runner needs at runtime. `bun install`
# resolves oblaka-iac + @propustka/* from npm (wrangler is installed globally above).
COPY packages/runner/docker/package.json ./package.json
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
