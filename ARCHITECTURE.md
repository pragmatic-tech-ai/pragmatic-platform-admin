# pragmatic-platform-admin architecture

> Navigational map. Line numbers drift; trust the symbol names. Update this file when a seam below moves.

The platform admin console, split out of pragmatic-server (`admin/control-plane/` → `src/`, `admin/portal/` →
`portal/`, `environments/` → `src/environments/`). Shared code comes from pragmatic-shared packages:
`pragmatic-tenant-plane` (the co-hosted tenant plane, the environment records, services and runtimes, the hive layer,
the record stores; transitional until C5.3), `pragmatic-kube` (Kubernetes client), `pragmatic-release-toolkit`
(release descriptors, signing and verification, OCI registry, closure check, descriptor CLI), `pragmatic-platform-link`
(internal API, agent channel and desktop discovery contracts and hosts), `pragmatic-app-host`, the identity and realm
packages. The console implements the plane's contracts (`IEnvironmentService`, `IGraphService`, `IIdpService`,
`IOwnerSessionRevoker`, `IUiDeployActuator`, `IDockerEnv`, `ITenantDirectory`, `ITenantRecordSource`,
`IHiveImageSigner`, `ISealedSecrets`).

| Area | Files (under `src/`) |
|---|---|
| Entry and composition | `server.ts` (`ControlPlaneServer`: reads the environment, composes the stores, signing, releases, the tenant plane and the listeners; role check `control-plane-role.ts`: `admin`; `edge` and the retired `all` refused), `control-plane-host.ts` (`ControlPlaneHost`: the operator REST API and events socket on pragmatic-app-host), `internal/` (`InternalHost`: the internal listener on pragmatic-app-host carrying the edge's internal API, the ledger's entitlement statements and the customer API; `InternalSettings`), `control-plane-problems.ts` |
| Operators | `operator-identity.ts` (`OperatorIdentity`: bootstrap operator, roles, password reset, disable), `operator-sessions.ts`, `operator-socket-registry.ts`, `login-throttle.ts` |
| Clients and entitlements | `platform-records.ts` (`ClientRecord`, `PlatformTenantRecord`, `PlatformHiveRecord`), `entitlements/` (`SqlEntitlementSink`, `ClientProjection`, `OperatorEntitlementGate`), `customer/` (`PlatformCustomerApiService`, `ClientUsage`, `ClientLock`, `HiveViews`, `CentralLoginSettings`, `CentralLoginVerifiers`), `enrolment/` (`EnrolmentCodeIssuer`, `EngineInstallCommand`), `placement/` (`PlacementRegistry`) |
| Signed agent channel (C3.3) | `hive-channel/` (`HiveChannel`: composes the exchange under the platform signing key; `PlatformAgentExchange`: verify, dispatch by kind, sign the answer; `AgentExchangeRoute`: `POST /internal/v2/agent/exchange` on the internal listener; `SqlNonceLedger` (`hive_nonces`); `PlatformKeyDirectory`: enrolled hive keys from the hive records; `HiveEnrolmentHandler`: one-time code to hive record by public key; `HiveReportHandler`: signed reports into `HiveObservationRegistry`; `HiveIdAllocator`) |
| Storage and keys | `platform-admin-database.ts`, `platform-directory.ts`, `client-registry.ts`, `tenant-registry.ts`, `hive-registry.ts`, `idp-registry.ts`, the `*-record.ts` files, `key-stores.ts`, `pinned-key-store.ts`, `sealed-secret-store.ts`, `platform-signing-key.ts`, `signature-store.ts`, `sql-signature-store.ts` |
| Tenants and IdPs | `tenant-provisioning-service.ts`, `provisioning-orchestrator.ts`, `tenant-admin-bootstrap.ts`, `tenant-console-installer.ts` (writes the release descriptors ConfigMap through `console-release-descriptors.ts` / `release-descriptors-config-map.ts`; rolls the console first, waits on its configuration preparation status through `component-configuration-readiness.ts`, then applies the IdP Deployment split off by `console-bootstrap-split.ts`; holds an existing hive agent with the configuration mounts attached through `agent-configuration-hold.ts`), `idp-service.ts`, `docker-idp-driver.ts`, `in-cluster-idp-driver.ts`, `in-cluster-idp-seed.ts`, `in-hive-idp-admin.ts`, `idp-container-env.ts`, `dev-certificate-authority.ts` |
| Email domains and console adverts | `platform-email-domains.ts`, `domain-claims.ts`, `domain-verification-rechecker.ts`, `txt-resolver.ts`, `console-domain-approvals.ts`, `console-advert-receiver.ts`, `console-advert-registry.ts`, `console-owner-resets.ts`, `console-retention.ts` |
| Hives and infrastructure | `platform-hive-orchestrator-factory.ts`, `hosted-hive-orchestrator-factory.ts`, `kind-hive-orchestrator.ts`, `kind.ts`, `hosted-kubeconfig.ts`, `infra-target-mode.ts`, `no-infra-target.ts`, `hive-agent-installer.ts`, `hive-agent-uninstaller.ts`, `hive-bootstrap-bundle.ts`, `hive-console-spec.ts`, `docker-env-port.ts`, `ui-deploy-actuator.ts`, `tenant-api/in-process-rollout-client.ts` |
| Images and releases | `platform-images.ts` (`DevPlatformImages` / `ReleasePlatformImages`), `manifest-signer.ts`, `image-digest.ts`, `platform-deployment-registry.ts`, `version-order.ts`, `release/` (`ReleaseCatalog`, `ReleaseCatalogConfig`, `PlatformReleaseCountersigner`, `ReleasePoll`, `ReleaseRefresher`, `ReleaseDescriptorSource` and `GitHubReleaseManifestSource`: a release's component descriptors); trust keys in `../release-keys/` |
| Agent channel and desktop discovery (answered in-process, to the edge over the internal API) | `local-agent-channel-backend.ts`, `desktop-discovery-backend.ts`, `desktop-tenant-matcher.ts`; `runtime-reader-security.ts` is the security setting the operator-run loops give a Runtime environment created without a creator |
| Component | `platform-admin-component.ts` (`PlatformAdminComponent`: the descriptor, version = package version), `release-components.ts` (`Components`, read by `pragmatic-component-descriptors --components dist/release-components.js`) |
| Import CLI | `bin/pragmatic-admin-import.ts`, `platform-admin-import.ts` |
| Local environments | `environments/seed/` (`SeedCli`, `DockerEnv`, smoke), `environments/dev`, `environments/demo` |

`portal/`: the operator SPA (Mural, pragmatic-app-shell; `.mu` compiled by `scripts/compile-mu.mjs`), served from
`portal/dist` (or `PRAGMATIC_ADMIN_PORTAL_DIR`). The co-hosted tenant plane's static root is `PRAGMATIC_TENANT_PORTAL_DIR` or `tenant-portal/dist`,
which this repository does not hold (README, Roles). `closure.json`, `Dockerfile` and `docker-bake.hcl` are rendered by
`pragmatic-container-template`; `pragmatic-closure-check` keeps them and the code in step.

Tests: `src/**/tests/` (the console, its release catalogue, the seed; Postgres cases on `PRAGMATIC_TEST_PG_URL`, else
pg-mem), `tests/` (the release module's descriptor equals the pragmatic-server golden digest; one installed copy each
of todl-runtime, todl and mural), `portal/tests` and `portal/src/**/tests`.
