import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { AgentChannelOperation, type DiscoveryReply, type IDesktopDiscoveryBackend, InternalApiRoutes } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { InternalApiCredential, JsonPostClient } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CustomerCallAuthenticator, EntitlementSender, EntitlementsLink, ReceiptOutcome } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { CentralLoginSubject, EntitlementStatement, ICentralLoginVerifier, IEntitlementSink } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CustomerApiError, CustomerApiLink, CustomerErrorCode, CustomerOperation, TenantView } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import type { CreateTenantRequest, DomainVerification, DomainVerificationRequest, EnrolmentStart, EnvironmentRequest, HiveView, ICustomerApiService, LeaveHiveRequest, ListHivesRequest, ListTenantsRequest, RequestEnvironmentRequest, StartEnrolmentRequest } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { InternalHost, InternalLink } from '../internal-host.js'
import { InternalSettings } from '../internal-settings.js'
import { CentralLoginSettings } from '../../customer/central-login-settings.js'
import { LocalAgentChannelBackend } from '../../local-agent-channel-backend.js'
import { ClientRegistry } from '../../client-registry.js'
import { TenantRegistry } from '../../tenant-registry.js'
import { HiveRegistry } from '../../hive-registry.js'
import { PlatformDirectory } from '../../platform-directory.js'
import { HiveOrchestratorFactory, HiveBackend, InfraMode } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { PlatformDeploymentRegistry } from '../../platform-deployment-registry.js'
import { RolloutFixture } from '../../tests/rollout-fixture.js'
import { EntitlementSamples } from '../../entitlements/tests/entitlement-samples.js'

type Reply = { status: number; body: unknown }

class FixedDiscovery implements IDesktopDiscoveryBackend
{
    public readonly Asked: string[] = []

    public async Discover(email: string): Promise<DiscoveryReply>
    {
        this.Asked.push(email)
        return { Status: 200, Body: { tenants: [{ id: 'acme', displayName: 'Acme', consoleUrl: 'https://c.example' }] } }
    }
}

class MemorySink implements IEntitlementSink
{
    public readonly Applied: EntitlementStatement[] = []

    public async CurrentVersion(clientId: string): Promise<number | undefined>
    {
        return this.Applied.filter(statement => statement.ClientId === clientId).at(-1)?.Version
    }

    public async Apply(statement: EntitlementStatement): Promise<void>
    {
        this.Applied.push(statement)
    }
}

/** Accepts exactly the one token it was given. */
class OneTokenVerifier implements ICentralLoginVerifier
{
    public static readonly Token = 'customer-token-1'

    public async Verify(token: string): Promise<CentralLoginSubject | undefined>
    {
        return token === OneTokenVerifier.Token ? EntitlementSamples.Admin() : undefined
    }
}

/** Answers list-tenants; every other operation is not expected here. */
class ListOnlyService implements ICustomerApiService
{
    public readonly Callers: CentralLoginSubject[] = []
    public static readonly Created = new Date('2026-11-22T00:00:00.000Z')

    public async ListTenants(customer: CentralLoginSubject, request: ListTenantsRequest): Promise<readonly TenantView[]>
    {
        this.Callers.push(customer)
        return [new TenantView('acme-main', request.ClientId, 'Main', ListOnlyService.Created)]
    }

    public CreateTenant(_customer: CentralLoginSubject, _request: CreateTenantRequest): Promise<TenantView>
    {
        return ListOnlyService.Refuse()
    }

    public StartEnrolment(_customer: CentralLoginSubject, _request: StartEnrolmentRequest): Promise<EnrolmentStart>
    {
        return ListOnlyService.Refuse()
    }

    public ListHives(_customer: CentralLoginSubject, _request: ListHivesRequest): Promise<readonly HiveView[]>
    {
        return ListOnlyService.Refuse()
    }

    public StartDomainVerification(_customer: CentralLoginSubject, _request: DomainVerificationRequest): Promise<DomainVerification>
    {
        return ListOnlyService.Refuse()
    }

    public CheckDomainVerification(_customer: CentralLoginSubject, _request: DomainVerificationRequest): Promise<DomainVerification>
    {
        return ListOnlyService.Refuse()
    }

    public LeaveHive(_customer: CentralLoginSubject, _request: LeaveHiveRequest): Promise<HiveView>
    {
        return ListOnlyService.Refuse()
    }

    public RequestEnvironment(_customer: CentralLoginSubject, _request: RequestEnvironmentRequest): Promise<EnvironmentRequest>
    {
        return ListOnlyService.Refuse()
    }

    private static Refuse<T>(): Promise<T>
    {
        return Promise.reject(new CustomerApiError(CustomerErrorCode.Unavailable))
    }
}

class InternalFixture
{
    public static readonly HiveId = 'local1'
    public static readonly Loopback = '127.0.0.1'
    public static readonly InternalSecret = 'k'.repeat(40)
    public static readonly EntitlementsSecret = 'e'.repeat(40)
    public static readonly CustomerSecret = 'c'.repeat(40)
    public static readonly ShortSecret = 'short'

    public static Url(host: InternalHost): string
    {
        const addr = host.Address()
        return 'http://' + addr.address + ':' + String(addr.port)
    }

    public static readonly MeshHost = 'padmin.mesh.example'
    public static readonly OtherHost = 'evil.example'

    public static Send(host: InternalHost, method: string, path: string, bearer: string | undefined, body?: unknown, hostHeader?: string): Promise<Reply>
    {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (hostHeader !== undefined)
        {
            headers.host = hostHeader
        }
        if (bearer !== undefined)
        {
            headers.authorization = 'Bearer ' + bearer
        }
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () =>
                {
                    const text = Buffer.concat(chunks).toString('utf8')
                    resolve({ status: res.statusCode ?? 0, body: text.length === 0 ? undefined : JSON.parse(text) })
                })
            })
            req.on('error', reject)
            req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
        })
    }
}

describe('InternalHost', () =>
{
    const F = InternalFixture
    let parent: string
    let deployments: PlatformDeploymentRegistry
    let token: string
    let credential: InternalApiCredential
    let discovery: FixedDiscovery
    let sink: MemorySink
    let service: ListOnlyService
    let agent: LocalAgentChannelBackend
    let host: InternalHost
    let files: { Internal: string; Entitlements: string; Customer: string }

    const Settings = (links: { Entitlements?: boolean; Customer?: boolean } = { Entitlements: true, Customer: true }): InternalSettings =>
        new InternalSettings(0, F.Loopback, files.Internal, links.Entitlements === true ? files.Entitlements : undefined,
            links.Customer === true ? files.Customer : undefined, links.Customer === true ? CentralLoginSettings.Of({}) : undefined)

    const Start = async (settings: InternalSettings): Promise<InternalHost> =>
    {
        const started = new InternalHost(settings, { Agent: agent, Discovery: discovery, Sink: sink, Customer: service, Verifier: new OneTokenVerifier() })
        await started.Listen()
        return started
    }

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'internal-host-'))
        const directory = new PlatformDirectory(new ClientRegistry(join(parent, 'clients.json')), new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')), { List: () => [] })
        await directory.Load()
        await directory.RecordClient({ id: 'acme', displayName: 'Acme' })
        await directory.CreateTenant({ id: 't1', clientId: 'acme', displayName: 'T' })
        await directory.CreateHive({ id: F.HiveId, tenantId: 't1', displayName: 'L', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        deployments = await RolloutFixture.Create(parent, directory, new HiveOrchestratorFactory())
        token = await deployments.RegisterHive(F.HiveId)
        files = { Internal: join(parent, 'internal'), Entitlements: join(parent, 'entitlements'), Customer: join(parent, 'customer') }
        writeFileSync(files.Internal, F.InternalSecret)
        writeFileSync(files.Entitlements, F.EntitlementsSecret)
        writeFileSync(files.Customer, F.CustomerSecret)
        credential = InternalApiCredential.FromFile(files.Internal)
        discovery = new FixedDiscovery()
        sink = new MemorySink()
        service = new ListOnlyService()
        agent = new LocalAgentChannelBackend(deployments)
        host = await Start(Settings())
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('carries the three links when all are configured', () =>
    {
        assert.deepEqual(host.Links, [InternalLink.InternalApi, InternalLink.Entitlements, InternalLink.CustomerApi])
    })

    it('refuses a missing or wrong internal bearer with 401 on every internal-API route, and runs nothing', async () =>
    {
        const entitlementsBearer = EntitlementsLink.CredentialFromFile(files.Entitlements).Bearer()
        for (const path of [InternalApiRoutes.Agent, InternalApiRoutes.Discover])
        {
            for (const bearer of [undefined, 'wrong', credential.Bearer() + 'x', entitlementsBearer])
            {
                const reply = await F.Send(host, 'POST', path, bearer, { Operation: AgentChannelOperation.Target, HiveId: F.HiveId, Token: token, email: 'a@b.c' })
                assert.equal(reply.status, 401)
                assert.equal((reply.body as { code: string }).code, 'unauthorized')
            }
        }
        assert.deepEqual(discovery.Asked, [])
    })

    it('the agent and discovery routes answer as before with the internal bearer', async () =>
    {
        await deployments.Publish('1.0.0', 'img:1')
        await deployments.Gate('t1', '1.0.0')
        await deployments.SelectTarget(F.HiveId, '1.0.0')
        const ok = await F.Send(host, 'POST', InternalApiRoutes.Agent, credential.Bearer(), { Operation: AgentChannelOperation.Target, HiveId: F.HiveId, Token: token })
        assert.deepEqual(ok, { status: 200, body: { Status: 200, Body: { version: '1.0.0', image: 'img:1' } } })
        const badToken = await F.Send(host, 'POST', InternalApiRoutes.Agent, credential.Bearer(), { Operation: AgentChannelOperation.Target, HiveId: F.HiveId, Token: 'wrong' })
        assert.deepEqual(badToken, { status: 200, body: { Status: 401, Body: { error: 'Unauthorized' } } })
        const found = await F.Send(host, 'POST', InternalApiRoutes.Discover, credential.Bearer(), { email: 'ann@acme.test' })
        assert.deepEqual(found, { status: 200, body: { Status: 200, Body: { tenants: [{ id: 'acme', displayName: 'Acme', consoleUrl: 'https://c.example' }] } } })
        assert.deepEqual(discovery.Asked, ['ann@acme.test'])
    })

    it('answers 400 for malformed JSON or an invalid request shape', async () =>
    {
        assert.equal((await F.Send(host, 'POST', InternalApiRoutes.Agent, credential.Bearer(), '{not json')).status, 400)
        assert.equal((await F.Send(host, 'POST', InternalApiRoutes.Agent, credential.Bearer(), { Operation: 'rm -rf', HiveId: 'x', Token: 't' })).status, 400)
        assert.equal((await F.Send(host, 'POST', InternalApiRoutes.Discover, credential.Bearer(), { email: 42 })).status, 400)
    })

    it('accepts a 1 MiB hive body that JSON escaping doubles (the edge forwards up to 1 MiB raw)', async () =>
    {
        const body = '"'.repeat(1048576)
        const reply = await F.Send(host, 'POST', InternalApiRoutes.Agent, credential.Bearer(), { Operation: AgentChannelOperation.Snapshot, HiveId: F.HiveId, Token: token, Body: body })
        assert.equal(reply.status, 200)
        assert.deepEqual(reply.body, { Status: 400, Body: { error: 'Request body must be { environments: HiveHealth[] }' } })
    })

    it('answers an oversized request with a delivered 413', async () =>
    {
        const reply = await F.Send(host, 'POST', InternalApiRoutes.Agent, credential.Bearer(), 'x'.repeat(8 * 1048576))
        assert.equal(reply.status, 413)
    })

    it('serves the internal healthz without auth and 404 for an unknown path', async () =>
    {
        assert.deepEqual(await F.Send(host, 'GET', InternalApiRoutes.Healthz, undefined), { status: 200, body: { ok: true } })
        assert.equal((await F.Send(host, 'GET', '/internal/v1/other', credential.Bearer())).status, 404)
        assert.equal((await F.Send(host, 'POST', '/internal/customer/v1/unknown-op', credential.Bearer(), {})).status, 404)
    })

    it('a statement with the entitlements bearer is applied; with the internal-api bearer it is 401', async () =>
    {
        const sender = new EntitlementSender(F.Url(host), EntitlementsLink.CredentialFromFile(files.Entitlements))
        const receipt = await sender.Send(EntitlementSamples.Statement(1))
        assert.equal(receipt.Outcome, ReceiptOutcome.Applied)
        assert.equal((await sender.Send(EntitlementSamples.Statement(1))).Outcome, ReceiptOutcome.Duplicate)
        assert.equal(sink.Applied.length, 1)
        const wrong = await F.Send(host, 'POST', EntitlementsLink.StatementsPath, credential.Bearer(), EntitlementSamples.Statement(2).ToJson())
        assert.equal(wrong.status, 401)
        assert.equal(sink.Applied.length, 1)
    })

    it('a customer call with the customer-api bearer and a valid customer token reaches the service', async () =>
    {
        const client = new JsonPostClient(F.Url(host))
        const path = CustomerApiLink.InternalPathOf(CustomerOperation.ListTenants)
        const link = CustomerApiLink.CredentialFromFile(files.Customer)
        const ok = await client.Post(path, { ClientId: 'acme' }, CustomerCallAuthenticator.Headers(link, OneTokenVerifier.Token))
        assert.equal(ok.Status, 200)
        assert.deepEqual(ok.Body, { Tenants: [{ TenantId: 'acme-main', ClientId: 'acme', DisplayName: 'Main', CreatedAt: ListOnlyService.Created.toISOString() }] })
        assert.equal(service.Callers.length, 1)
        const notSignedIn = await client.Post(path, { ClientId: 'acme' }, CustomerCallAuthenticator.Headers(link, 'other-token'))
        assert.deepEqual([notSignedIn.Status, (notSignedIn.Body as { code: string }).code], [401, CustomerErrorCode.NotSignedIn])
        const internalBearer = await client.Post(path, { ClientId: 'acme' }, CustomerCallAuthenticator.Headers(credential, OneTokenVerifier.Token))
        assert.deepEqual([internalBearer.Status, (internalBearer.Body as { code: string }).code], [401, CustomerErrorCode.Unauthorized])
        assert.equal(service.Callers.length, 1)
    })

    it('without a link\'s setting its routes are absent (404) and the listener still starts', async () =>
    {
        await host.Close()
        host = await Start(Settings({}))
        assert.deepEqual(host.Links, [InternalLink.InternalApi])
        assert.equal((await F.Send(host, 'POST', EntitlementsLink.StatementsPath, undefined, EntitlementSamples.Statement(1).ToJson())).status, 404)
        assert.equal((await F.Send(host, 'POST', CustomerApiLink.InternalPathOf(CustomerOperation.CreateTenant), undefined, {})).status, 404)
        assert.equal((await F.Send(host, 'GET', InternalApiRoutes.Healthz, undefined)).status, 200)
    })

    it('answers loopback Host names always, an allowed host when configured, and refuses any other Host', async () =>
    {
        assert.equal((await F.Send(host, 'GET', InternalApiRoutes.Healthz, undefined, undefined, F.OtherHost)).status, 403)
        assert.equal((await F.Send(host, 'POST', InternalApiRoutes.Discover, credential.Bearer(), { email: 'a@b.c' }, F.MeshHost)).status, 403)
        await host.Close()
        host = await Start(new InternalSettings(0, F.Loopback, files.Internal, undefined, undefined, undefined, [F.MeshHost]))
        assert.equal((await F.Send(host, 'POST', InternalApiRoutes.Discover, credential.Bearer(), { email: 'a@b.c' }, F.MeshHost + ':7001')).status, 200)
        assert.equal((await F.Send(host, 'POST', InternalApiRoutes.Discover, credential.Bearer(), { email: 'a@b.c' }, F.OtherHost)).status, 403)
    })

    it('a link whose setting is on without its part refuses the start, naming the setting', () =>
    {
        assert.throws(() => new InternalHost(Settings({ Entitlements: true }), { Agent: agent, Discovery: discovery }), /PRAGMATIC_ADMIN_ENTITLEMENTS_SECRET_FILE/)
        assert.throws(() => new InternalHost(Settings({ Customer: true }), { Agent: agent, Discovery: discovery, Customer: service }), /PRAGMATIC_ADMIN_CUSTOMER_API_SECRET_FILE/)
    })

    it('a missing or short secret file named in the settings refuses the start naming the variable', () =>
    {
        writeFileSync(join(parent, 'short'), F.ShortSecret)
        const parts = { Agent: agent, Discovery: discovery, Sink: sink, Customer: service, Verifier: new OneTokenVerifier() }
        assert.throws(() => new InternalHost(new InternalSettings(0, F.Loopback, files.Internal, join(parent, 'missing')), parts), /PRAGMATIC_ADMIN_ENTITLEMENTS_SECRET_FILE/)
        assert.throws(() => new InternalHost(new InternalSettings(0, F.Loopback, files.Internal, undefined, join(parent, 'short'), CentralLoginSettings.Of({})), parts), (err: Error) => /PRAGMATIC_ADMIN_CUSTOMER_API_SECRET_FILE/.test(err.message) && !err.message.includes(F.ShortSecret))
        assert.throws(() => new InternalHost(new InternalSettings(0, F.Loopback, join(parent, 'missing')), parts), /PRAGMATIC_INTERNAL_API_SECRET_FILE/)
        writeFileSync(join(parent, 'short-internal'), F.ShortSecret)
        assert.throws(() => new InternalHost(new InternalSettings(0, F.Loopback, join(parent, 'short-internal')), parts), (err: Error) => /PRAGMATIC_INTERNAL_API_SECRET_FILE/.test(err.message) && !err.message.includes(F.ShortSecret))
    })
})

describe('InternalSettings', () =>
{
    it('is off by default and when the port is 0 or blank', () =>
    {
        assert.equal(InternalSettings.Of({}), undefined)
        assert.equal(InternalSettings.Of({ PRAGMATIC_ADMIN_INTERNAL_PORT: '0' }), undefined)
        assert.equal(InternalSettings.Of({ PRAGMATIC_ADMIN_INTERNAL_PORT: ' ' }), undefined)
    })

    it('reads port, bind (default loopback) and the secret file; the links are off unless named', () =>
    {
        const settings = InternalSettings.Of({ PRAGMATIC_ADMIN_INTERNAL_PORT: '7001', PRAGMATIC_INTERNAL_API_SECRET_FILE: '/run/secrets/edge' })
        assert.deepEqual([settings?.Port, settings?.Bind, settings?.SecretFile, settings?.EntitlementsSecretFile, settings?.CustomerApiSecretFile, settings?.Central], [7001, '127.0.0.1', '/run/secrets/edge', undefined, undefined, undefined])
        assert.equal(InternalSettings.Of({ PRAGMATIC_ADMIN_INTERNAL_PORT: '7001', PRAGMATIC_ADMIN_INTERNAL_BIND: '0.0.0.0', PRAGMATIC_INTERNAL_API_SECRET_FILE: '/s' })?.Bind, '0.0.0.0')
    })

    it('answers the bind address unless it is a wildcard, plus the allowed hosts setting', () =>
    {
        const base = { PRAGMATIC_ADMIN_INTERNAL_PORT: '7001', PRAGMATIC_INTERNAL_API_SECRET_FILE: '/s' }
        assert.deepEqual(InternalSettings.Of({ ...base, PRAGMATIC_ADMIN_INTERNAL_BIND: '100.64.0.1' })?.HostNames, ['100.64.0.1'])
        assert.deepEqual(InternalSettings.Of({ ...base, PRAGMATIC_ADMIN_INTERNAL_BIND: '0.0.0.0' })?.HostNames, [])
        assert.deepEqual(InternalSettings.Of({ ...base, PRAGMATIC_ADMIN_INTERNAL_BIND: '::', PRAGMATIC_ADMIN_INTERNAL_ALLOWED_HOSTS: ' a.mesh , b.mesh,' })?.HostNames, ['a.mesh', 'b.mesh'])
    })

    it('reads the entitlements and customer links, the customer link with its central login', () =>
    {
        const settings = InternalSettings.Of({ PRAGMATIC_ADMIN_INTERNAL_PORT: '7001', PRAGMATIC_INTERNAL_API_SECRET_FILE: '/s', PRAGMATIC_ADMIN_ENTITLEMENTS_SECRET_FILE: '/e', PRAGMATIC_ADMIN_CUSTOMER_API_SECRET_FILE: '/c', PRAGMATIC_ADMIN_CENTRAL_AUDIENCE: 'aud' })
        assert.deepEqual([settings?.EntitlementsSecretFile, settings?.CustomerApiSecretFile, settings?.Central?.Audience], ['/e', '/c', 'aud'])
    })

    it('refuses a port without a secret file, an invalid port or bind, and a link without the listener, naming the setting', () =>
    {
        assert.throws(() => InternalSettings.Of({ PRAGMATIC_ADMIN_INTERNAL_PORT: '7001' }), /PRAGMATIC_INTERNAL_API_SECRET_FILE/)
        assert.throws(() => InternalSettings.Of({ PRAGMATIC_ADMIN_INTERNAL_PORT: '70000', PRAGMATIC_INTERNAL_API_SECRET_FILE: '/s' }), /PRAGMATIC_ADMIN_INTERNAL_PORT/)
        assert.throws(() => InternalSettings.Of({ PRAGMATIC_ADMIN_INTERNAL_PORT: 'x', PRAGMATIC_INTERNAL_API_SECRET_FILE: '/s' }), /PRAGMATIC_ADMIN_INTERNAL_PORT/)
        assert.throws(() => InternalSettings.Of({ PRAGMATIC_ADMIN_INTERNAL_PORT: '7001', PRAGMATIC_ADMIN_INTERNAL_BIND: 'nope', PRAGMATIC_INTERNAL_API_SECRET_FILE: '/s' }), /PRAGMATIC_ADMIN_INTERNAL_BIND/)
        assert.throws(() => InternalSettings.Of({ PRAGMATIC_ADMIN_ENTITLEMENTS_SECRET_FILE: '/e' }), /PRAGMATIC_ADMIN_ENTITLEMENTS_SECRET_FILE.*PRAGMATIC_ADMIN_INTERNAL_PORT/)
        assert.throws(() => InternalSettings.Of({ PRAGMATIC_ADMIN_CUSTOMER_API_SECRET_FILE: '/c' }), /PRAGMATIC_ADMIN_CUSTOMER_API_SECRET_FILE.*PRAGMATIC_ADMIN_INTERNAL_PORT/)
    })
})
