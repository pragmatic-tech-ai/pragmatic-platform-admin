# pragmatic-platform-admin

The platform admin console (`server.ts`, image `ghcr.io/pragmatic-tech-ai/pragmatic-platform-admin`): the operator
plane (operators, clients, tenants, hives, the tenants' IdPs, email domains, releases), the release catalogue it
imports signed platform releases into, and the co-hosted tenant plane (`pragmatic-tenant-plane`, transitional until
C5.3). Its operator UI is `portal/`.

Split out of pragmatic-server (seed commit `chore: seed from pragmatic-server@2a2e8138`); image name, ports
(7000; 7001 is exposed by the image but served by the platform edge, never the console), environment variables, wire paths and the component descriptor are unchanged
(`tests/descriptor-golden.test.ts` pins the pragmatic-server digest).

## Roles

The console runs one role, `admin` (the default and the image's value): the operator host, the internal API for the
edge (when `PRAGMATIC_ADMIN_INTERNAL_PORT` is set) and the tenant plane. It never listens on the agent channel: the
platform edge (`pragmatic-platform-edge`) serves it and answers through the internal API, and
`PRAGMATIC_AGENT_CHANNEL_PORT` / `PRAGMATIC_AGENT_CHANNEL_URL` only name that channel in hive bundles.
`PRAGMATIC_CONTROL_PLANE_ROLE=edge` and the retired `all` (the former single dev process that also served the agent
channel) are refused at start. Local stacks run the console and the edge as two processes (pragmatic-e2e's live loop).

The co-hosted tenant plane serves its SPA from `PRAGMATIC_TENANT_PORTAL_DIR` when set, else from
`<repository root>/tenant-portal/dist` (`server.ts`), a folder this repository does not hold (the tenant portal lives in
`pragmatic-tenant-admin`). The image never shipped it either, so nothing changes there; pragmatic-e2e's dev and
live-loop stacks point the variable at the tenant-admin checkout's build. Without it, the tenant plane's API works but
no tenant SPA is served.

## Development

Packages come from GitHub Packages (`@pragmatic-tech-ai` scope; `.npmrc` reads the token from `NODE_AUTH_TOKEN`).

    npm ci
    npm run build
    npm test
    npm run typecheck
    npx pragmatic-closure-check
    cd portal && npm ci && npm test && npm run build

Postgres-backed tests read `PRAGMATIC_TEST_PG_URL` (others run on pg-mem). `src/environments/` holds the local
Docker dev and demo environment definitions and the seed CLI (`src/environments/README.md`).

The image is built from `Dockerfile` with `docker-bake.hcl` in two steps (the header of either file shows the
commands); it carries `dist/`, `portal/dist/`, `release-keys/` (the default `PRAGMATIC_RELEASE_TRUST_DIR`), the
production `node_modules` and the kubectl, kind and docker CLIs. CI and the image release (tag `v<version>`, equal to
`package.json`'s version) run pragmatic-shared's reusable container workflows. The build files are rendered by
`pragmatic-container-template` (`@pragmatic-tech-ai/pragmatic-release-toolkit`):

    npx pragmatic-container-template render --app pragmatic-platform-admin --entry src/server.ts --ui portal --copy release-keys --out .

## License

Apache-2.0.
