# Local dev and demo environments

Two Docker-backed environment server environments: a development environment (`dev`, port 8080) and a runtime demo environment (`demo`, environment `contoso`, port 8081) running the Northwind sample application with a Power-Platform-style security model.

## One-time image build

The environments run the environment server's dev image `pragmatic-env-server:dev` (the name the tenant plane gives every
environment workload), baked from the `pragmatic-env-server` repository by the dev image builder of `pragmatic-e2e`.
From the `pragmatic-e2e` checkout, with the container repositories checked out beside it (or in
`PRAGMATIC_E2E_REPOS_DIR`):

```
npx tsx src/dev/dev-images.ts pragmatic-env-server
```

The `build` command and the missing-image hint print the same command.

## Bring-up

Run from this repository's root:

```
npx tsx src/environments/seed/seed.ts up dev
npx tsx src/environments/seed/seed.ts up demo
```

`up` builds the config bundle, seeds the data volume, starts the container, waits for health, and (demo only) creates the demo users. Other commands: `status`, `logs`, `seed-users` (demo only), `build` (prints the image build command).

## Connect

- dev: `ws://localhost:8080/?environment=dev`
- demo: `ws://localhost:8081/?environment=contoso`

## Login

`POST /auth/login?environment=<id>` with `{ "email", "password" }` returns `{ token }`; pass it as `Authorization: Bearer <token>` on the WebSocket upgrade. The admin principal is `admin` / `admin@<environment>.test`, with the password in the generated `provisioned-secrets.json` under `<environment>-admin-pw`.

Demo users (password under `<principalId>-pw`): `rep-boston`, `rep-atlanta`, `manager-north` (Editor) and `finance` (Viewer), all `@contoso.test`.

## Teardown

```
npx tsx src/environments/seed/seed.ts down dev
npx tsx src/environments/seed/seed.ts down demo
```

## Generated files

`master.key`, `provisioned-secrets.json`, `environments.json`, `realm-config.json`, and `data/` under each environment dir (`src/environments/<env>/`) are generated and gitignored. See `environments/demo/seed/provisioned-secrets.example.json` in pragmatic-tenant-plane (`node_modules/@pragmatic-tech-ai/pragmatic-tenant-plane`, which ships the demo seed) for the required secret refs; real secrets are generated fresh on first `up`.

## Integration smoke

`npx tsx src/environments/seed/smoke.ts` (needs Docker and the built image; operator-run, not part of `npx tsx --test`) brings up the demo and checks BU depth, field security, sharing, and assign, printing PASS or FAIL per axis.
