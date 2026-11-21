# pragmatic-platform-admin

The platform admin console (`server.ts`, image `ghcr.io/pragmatic-tech-ai/pragmatic-platform-admin`): the operator
plane (operators, clients, tenants, hives, the tenants' IdPs, email domains, releases), the release catalogue it
imports signed platform releases into, and the co-hosted tenant plane (`pragmatic-tenant-plane`, transitional until
C5.3). Its operator UI is `portal/`.

Split out of pragmatic-server (seed commit `chore: seed from pragmatic-server@2a2e8138`); image name, ports
(7000, 7001), environment variables, wire paths and the component descriptor are unchanged
(`tests/descriptor-golden.test.ts` pins the pragmatic-server digest).

## Roles

`PRAGMATIC_CONTROL_PLANE_ROLE` is read as before: `admin` (the image's value) and `all` (the single local dev
process, also serving the agent channel and desktop discovery) start the console; `edge` is refused, since the
platform edge has its own entry and repository (`pragmatic-platform-edge`). Retiring `all` waits for the live loop's
move to `pragmatic-e2e`.

The co-hosted tenant plane serves its SPA from `<repository root>/tenant-portal/dist` (`server.ts`), a folder this
repository does not hold (the tenant portal lives in `pragmatic-tenant-admin`). The image never shipped it either, so
nothing changes there; in a local `all` process with the tenant listener on, the tenant plane's API works but no tenant
SPA is served unless that folder is provided.

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
