# pragmatic-platform-admin

The platform admin console (`server.ts`, image `ghcr.io/pragmatic-tech-ai/pragmatic-platform-admin`): the operator
plane (operators, clients, tenants, hives, the tenants' IdPs, email domains, releases), the release catalogue it
imports signed platform releases into, and the co-hosted tenant plane (`pragmatic-tenant-plane`, transitional until
C5.3). Its operator UI is `portal/`.

Split out of pragmatic-server (seed commit `chore: seed from pragmatic-server@2a2e8138`). Ports: 7000 (the operator
listener) and 7001 (the internal listener, loopback or mesh only). `tests/descriptor-golden.test.ts` pins the component
descriptor's digest (D4 added the `entitlements` and `customerApi` options).

## Roles

The console runs one role, `admin` (the default and the image's value): the operator host, the internal API for the
edge (when `PRAGMATIC_ADMIN_INTERNAL_PORT` is set) and the tenant plane. It never listens on the agent channel: the
platform edge (`pragmatic-platform-edge`) serves it and answers through the internal API, and
`PRAGMATIC_AGENT_CHANNEL_PORT` / `PRAGMATIC_AGENT_CHANNEL_URL` only name that channel in hive bundles.
`PRAGMATIC_CONTROL_PLANE_ROLE=edge` and the retired `all` (the former single dev process that also served the agent
channel) are refused at start. Local stacks run the console and the edge as two processes (pragmatic-e2e's live loop).

## The internal listener

`PRAGMATIC_ADMIN_INTERNAL_PORT` (with `PRAGMATIC_ADMIN_INTERNAL_BIND`, default `127.0.0.1`) turns on the internal
listener (`internal/internal-host.ts`, an AppHost answering the loopback host names only). It carries one link per
caller, each with its own secret file (at least 32 bytes; a refusal names the setting, never the content):

| Link | Setting | Routes |
|---|---|---|
| The edge's internal API (agent channel, desktop discovery) | `PRAGMATIC_INTERNAL_API_SECRET_FILE` (required) | `POST /internal/v1/agent`, `POST /internal/v1/desktop/discover`, `GET /internal/v1/healthz` |
| The clients ledger's entitlement statements | `PRAGMATIC_ADMIN_ENTITLEMENTS_SECRET_FILE` (the ledger's `PRAGMATIC_LEDGER_ENTITLEMENTS_SECRET_FILE`) | `POST /internal/entitlements/v1/statements` |
| The customer API the edge relays for the personal cabinet | `PRAGMATIC_ADMIN_CUSTOMER_API_SECRET_FILE` (the edge's `PRAGMATIC_EDGE_CUSTOMER_API_SECRET_FILE`) | `POST /internal/customer/v1/<operation>` |

Without a link's setting its routes answer 404. The customer API verifies the customer admin's own central-login token
(header `x-pragmatic-customer-token`): issuer `PRAGMATIC_ADMIN_CENTRAL_ISSUER` (default the central realm), audience
`PRAGMATIC_ADMIN_CENTRAL_AUDIENCE` (default `pragmatic-cabinet`), CA bundle `PRAGMATIC_ADMIN_OIDC_CA_BUNDLE` (optional).
The statements land in `records_entitlements` (`entitlements/sql-entitlement-sink.ts`, newest version per client) and
derive the client records (`entitlements/client-projection.ts`).

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
