import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeOidcHttpClient, FakeOidcIdp } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { CentralLoginSubject, EntitlementState } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CreateTenantRequest, CustomerApiClient, CustomerApiError, CustomerApiLink, CustomerApiRelay, CustomerErrorCode, DomainVerificationRequest, DomainVerificationState, HiveHealth, HiveLevel, LeaveHiveRequest, ListHivesRequest, ListTenantsRequest, NotEntitledReason, StartEnrolmentRequest } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import type { IAgentChannelBackend, IDesktopDiscoveryBackend } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { CentralLoginSettings } from '../customer/central-login-settings.js'
import { CentralLoginVerifiers } from '../customer/central-login-verifiers.js'
import { CustomerFixture } from '../customer/tests/customer-fixture.js'
import { EntitlementSamples } from '../entitlements/tests/entitlement-samples.js'
import { EngineInstallCommand } from '../enrolment/engine-install-command.js'
import { InternalHost } from '../internal/internal-host.js'
import { InternalSettings } from '../internal/internal-settings.js'
import { TxtLookupStatus } from '../txt-resolver.js'

/**
 * A relay on the contract's CustomerApiRelay, in process: a public POST under the customer prefix carried to the
 * console's internal listener. It is not the platform edge (a separate application repository, not a package the
 * console can depend on): the edge's own relay, limits and logging are proven by its repository's tests (including a
 * round trip with this contract's CustomerApiClient and CustomerApiRoutes) and by the live probe on frontdoor; this test
 * proves the console's side of the wire end to end.
 */
class TestEdge
{
    private static readonly StatusNotFound = 404
    private static readonly ContentType = 'content-type'
    private static readonly Json = 'application/json'
    private static readonly Utf8 = 'utf8'
    private readonly server: Server

    public constructor(private readonly relay: CustomerApiRelay)
    {
        this.server = createServer((req, res) =>
        {
            void this.Serve(req, res)
        })
    }

    public async Listen(): Promise<string>
    {
        await new Promise<void>(resolve => this.server.listen(0, E2e.Loopback, () => resolve()))
        return E2e.LoopbackUrl + String((this.server.address() as AddressInfo).port)
    }

    public Close(): Promise<void>
    {
        this.server.closeAllConnections()
        return new Promise(resolve => this.server.close(() => resolve()))
    }

    private async Serve(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const chunks: Buffer[] = []
        for await (const chunk of req)
        {
            chunks.push(chunk as Buffer)
        }
        const operation = this.relay.OperationOf(req.method, req.url ?? '')
        if (operation === undefined)
        {
            res.writeHead(TestEdge.StatusNotFound).end()
            return
        }
        const text = Buffer.concat(chunks).toString(TestEdge.Utf8)
        const header = req.headers.authorization
        const reply = await this.relay.Relay(operation, typeof header === 'string' ? header : undefined, text.length === 0 ? {} : JSON.parse(text))
        res.writeHead(reply.Status, { [TestEdge.ContentType]: TestEdge.Json }).end(JSON.stringify(reply.Body))
    }
}

class E2e
{
    public static readonly Issuer = 'https://login.e2e.test/realms/central'
    public static readonly Audience = 'pragmatic-cabinet'
    public static readonly Subject = 'gip-e2e-admin'
    public static readonly Email = 'admin@acme.test'
    public static readonly TenantId = 'acme-main'
    public static readonly Domain = 'acme.test'
    public static readonly OperatorHive = 'acme-hive'
    public static readonly Secret = 's'.repeat(40)
    public static readonly Limits = { 'tenants': 2, 'hives': 5, 'verified-domains': 2 }
    public static readonly OtherAudience = 'pragmatic-ledger'
    public static readonly DirPrefix = 'customer-e2e-'
    public static readonly InternalFile = 'internal'
    public static readonly CustomerFile = 'customer'
    public static readonly InternalSuffix = 'i'
    public static readonly CustomerSuffix = 'c'
    public static readonly Loopback = '127.0.0.1'
    public static readonly LoopbackUrl = 'http://127.0.0.1:'
    public static readonly OtherClient = 'globex'
    public static readonly SecondTenant = 'acme-second'
    public static readonly SecondName = 'Second'
    public static readonly BadTenantId = 'Not_A_Tenant'
    public static readonly ReservedTenantId = 'admin'
    public static readonly BadDisplayName = 'x'
    public static readonly GarbageToken = 'not-a-token'
    public static readonly Label = 'customer API end to end: CustomerApiClient -> a CustomerApiRelay relay -> InternalHost -> PlatformCustomerApiService'

    public static Admin(): CentralLoginSubject
    {
        return CentralLoginSubject.Of(E2e.Issuer, E2e.Subject, E2e.Email)
    }

    public static async Refusal(work: Promise<unknown>): Promise<[CustomerErrorCode, NotEntitledReason | undefined]>
    {
        try
        {
            await work
        }
        catch (err)
        {
            assert.ok(err instanceof CustomerApiError, String(err))
            return [err.CustomerCode, err.Reason]
        }
        assert.fail('expected a refusal')
    }
}

SqlTestSessions.Describe(E2e.Label, (makeSession, backend) => describe(backend, () =>
{
    const C = E2e
    const S = EntitlementSamples
    let dir: string
    let f: CustomerFixture
    let host: InternalHost
    let edge: TestEdge
    let client: CustomerApiClient
    let token: string
    let otherAudience: string

    before(async () =>
    {
        dir = mkdtempSync(join(tmpdir(), C.DirPrefix))
        const internalFile = join(dir, C.InternalFile)
        const customerFile = join(dir, C.CustomerFile)
        writeFileSync(internalFile, C.Secret + C.InternalSuffix)
        writeFileSync(customerFile, C.Secret + C.CustomerSuffix)
        const idp = await FakeOidcIdp.Create(C.Issuer)
        token = await idp.MintIdToken({ sub: C.Subject, aud: C.Audience, email: C.Email, email_verified: true })
        otherAudience = await idp.MintIdToken({ sub: C.Subject, aud: C.OtherAudience, email: C.Email, email_verified: true })
        f = await CustomerFixture.Open(await makeSession())
        await f.State(S.Statement(1, { Admins: [C.Admin()], Limits: C.Limits }))
        const central = new CentralLoginSettings(C.Issuer, C.Audience, undefined)
        const settings = new InternalSettings(0, C.Loopback, internalFile, undefined, customerFile, central)
        host = new InternalHost(settings, {
            Agent: {} as IAgentChannelBackend, Discovery: {} as IDesktopDiscoveryBackend,
            Customer: f.Service(), Verifier: CentralLoginVerifiers.Create(central, new FakeOidcHttpClient(idp)),
        })
        await host.Listen()
        const address = host.Address()
        edge = new TestEdge(new CustomerApiRelay(C.LoopbackUrl + String(address.port), CustomerApiLink.CredentialFromFile(customerFile)))
        client = new CustomerApiClient(await edge.Listen())
    })

    after(async () =>
    {
        await edge.Close()
        await host.Close()
        rmSync(dir, { recursive: true, force: true })
    })

    it('creates and lists a tenant', async () =>
    {
        assert.deepEqual(await client.ListTenants(token, new ListTenantsRequest(S.ClientId)), [])
        const created = await client.CreateTenant(token, new CreateTenantRequest(S.ClientId, C.TenantId, C.TenantId))
        assert.equal(created.TenantId, C.TenantId)
        assert.deepEqual((await client.ListTenants(token, new ListTenantsRequest(S.ClientId))).map(t => t.TenantId), [C.TenantId])
    })

    it('starts enrolment for each level', async () =>
    {
        const standalone = await client.StartEnrolment(token, new StartEnrolmentRequest(S.ClientId, C.TenantId, HiveLevel.Standalone))
        assert.equal(standalone.InstallCommand, EngineInstallCommand.For(HiveLevel.Standalone, f.Deployments.Release as string))
        for (const level of [HiveLevel.Enrolled, HiveLevel.Delegated])
        {
            const connected = await client.StartEnrolment(token, new StartEnrolmentRequest(S.ClientId, C.TenantId, level))
            assert.equal(connected.Level, level)
            assert.ok(connected.EnrolmentCode !== null && connected.ExpiresAt !== null)
        }
        const hosted = await client.StartEnrolment(token, new StartEnrolmentRequest(S.ClientId, C.TenantId, HiveLevel.Hosted))
        assert.ok(hosted.PlacementId !== null)
        const hives = await client.ListHives(token, new ListHivesRequest(S.ClientId))
        assert.deepEqual(hives.map(h => [h.HiveId, h.Health]), [[hosted.PlacementId, HiveHealth.Pending]])
    })

    it('starts and checks a domain verification', async () =>
    {
        const started = await client.StartDomainVerification(token, new DomainVerificationRequest(S.ClientId, C.TenantId, C.Domain))
        assert.equal(started.State, DomainVerificationState.Pending)
        f.Txt.Answer = { status: TxtLookupStatus.Found, records: [[started.RecordValue]] }
        assert.equal((await client.CheckDomainVerification(token, new DomainVerificationRequest(S.ClientId, C.TenantId, C.Domain))).State, DomainVerificationState.Verified)
    })

    it('leaves a hive', async () =>
    {
        await f.Hive(C.OperatorHive, C.TenantId)
        const left = await client.LeaveHive(token, new LeaveHiveRequest(S.ClientId, C.OperatorHive))
        assert.equal(left.Health, HiveHealth.Gone)
    })

    it('a missing, garbage or other-audience token is not-signed-in; an unknown client is not-admin-of-client', async () =>
    {
        assert.deepEqual(await C.Refusal(client.ListTenants(C.GarbageToken, new ListTenantsRequest(S.ClientId))), [CustomerErrorCode.NotSignedIn, undefined])
        assert.deepEqual(await C.Refusal(client.ListTenants(otherAudience, new ListTenantsRequest(S.ClientId))), [CustomerErrorCode.NotSignedIn, undefined])
        assert.deepEqual(await C.Refusal(client.ListTenants(token, new ListTenantsRequest(C.OtherClient))), [CustomerErrorCode.NotAdminOfClient, undefined])
    })

    it('a suspended client still lists but cannot create', async () =>
    {
        await f.State(S.Statement(2, { Admins: [C.Admin()], Limits: C.Limits, State: EntitlementState.Suspended }))
        assert.equal((await client.ListTenants(token, new ListTenantsRequest(S.ClientId))).length, 1)
        assert.deepEqual(await C.Refusal(client.CreateTenant(token, new CreateTenantRequest(S.ClientId, C.SecondTenant, C.SecondName))), [CustomerErrorCode.NotEntitled, NotEntitledReason.Suspended])
    })

    it('an invalid tenant id is a 400 invalid-request through the routes', async () =>
    {
        assert.deepEqual(await C.Refusal(client.CreateTenant(token, new CreateTenantRequest(S.ClientId, C.BadTenantId, C.BadDisplayName))), [CustomerErrorCode.InvalidRequest, undefined])
    })
}))
