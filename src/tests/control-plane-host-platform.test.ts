import { TestEntitlements } from './test-entitlements.js'
import { EntitlementState } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { EntitlementSamples } from '../entitlements/tests/entitlement-samples.js'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FakeProvisioning } from './fake-provisioning.js'
import type { PlatformDeploymentRegistry } from '../platform-deployment-registry.js'
import { ControlPlaneHost } from '../control-plane-host.js'
import { type IEnvironmentService, type IGraphService, HiveOrchestratorFactory, type IHiveOrchestrator, type HiveRecord, type IIdpService } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { RolloutFixture } from './rollout-fixture.js'
import { KindHiveOrchestrator } from '../kind-hive-orchestrator.js'
import { NoInfraTargetError } from '../no-infra-target.js'
import type { IKind } from '../kind.js'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSummary } from '../operator-identity.js'
import { HostSessions } from './host-sessions.js'
import { ClientRegistry } from '../client-registry.js'
import { TenantRegistry } from '../tenant-registry.js'
import { HiveRegistry } from '../hive-registry.js'
import { InvalidTenantIdError, type IdpConnection } from '../idp-service.js'
import { PlatformDirectory, RecordExistsError, RecordKind } from '../platform-directory.js'

type Reply = { status: number; body: string; cacheControl?: string }

class FakeOperator implements IOperatorIdentity
{
    public static readonly Token = 'valid-token'
    public static readonly Email = 'op@example.com'
    public static readonly PrincipalId = 'p1'

    /** The operator the planted session names. */
    public static Principal(): OperatorPrincipal
    {
        return { email: FakeOperator.Email, principalId: FakeOperator.PrincipalId, role: OperatorRole.Full }
    }

    public async Verify(email: string, password: string): Promise<OperatorPrincipal | null>
    {
        return null
    }

    public async PrincipalOf(principalId: string): Promise<OperatorPrincipal | null>
    {
        return { email: FakeOperator.Email, principalId, role: OperatorRole.Full }
    }

    public async ListOperators(): Promise<readonly OperatorSummary[]>
    {
        return []
    }

    public async SetOperatorRole(_email: string, _role: OperatorRole, _actorPrincipalId: string): Promise<void>
    {
    }

    public async ChangeOwnPassword(_p: string, _c: string, _n: string): Promise<boolean> { return false }
    public async ResetOperatorPassword(_email: string): Promise<string>
    {
        return ''
    }

    public async SetOperatorDisabled(_email: string, _disabled: boolean, _actorPrincipalId: string): Promise<void>
    {
    }

    public async RevokeOperatorSessions(_email: string): Promise<void>
    {
    }

    public async CreateOperator(_email: string, _password: string, _role: OperatorRole): Promise<void>
    {
    }
}

class Harness
{
    public static readonly AuthCookie = 'cp_session=valid-token'

    public static ProvisionBody(): { client: Record<string, unknown>; tenant: Record<string, unknown>; hive: Record<string, unknown> }
    {
        return {
            client: { existing: true, id: 'acme' },
            tenant: { id: 't1', displayName: 'T', ownerEmail: 'o@x.test' },
            hive: { id: 'h1', displayName: 'H', cluster: { backend: 'local', mode: 'provision' }, registry: { mode: 'provision' } }
        }
    }

    public static Send(host: ControlPlaneHost, method: string, path: string, body?: unknown, authed: boolean = true): Promise<Reply>
    {
        const text = body === undefined ? undefined : JSON.stringify(body)
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (authed)
        {
            headers.cookie = Harness.AuthCookie
        }
        if (text !== undefined)
        {
            headers['content-length'] = String(Buffer.byteLength(text))
        }
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, cacheControl: res.headers['cache-control'], body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end(text)
        })
    }
}

class FakeKindFactory extends HiveOrchestratorFactory
{
    public readonly Deleted: string[] = []
    public FailWith: Error | undefined

    public override For(hive: HiveRecord): IHiveOrchestrator
    {
        const kind = {
            DeleteCluster: async (name: string) =>
            {
                if (this.FailWith)
                {
                    throw this.FailWith
                }
                this.Deleted.push(name)
            }
        } as unknown as IKind
        return new KindHiveOrchestrator(kind, 'hive-' + hive.id, undefined as unknown as IHiveOrchestrator)
    }
}

class FakeIdpService implements IIdpService
{
    private static readonly Failure = 'idp teardown failed'
    public TornDown: string[] = []
    public Fail = false

    public async EnsureForTenant(): Promise<IdpConnection>
    {
        throw new Error('not used')
    }

    public async ConnectForTenant(_tenantId: string): Promise<IdpConnection | undefined>
    {
        return undefined
    }

    public async TeardownForTenant(tenantId: string): Promise<void>
    {
        if (this.Fail)
        {
            throw new Error(FakeIdpService.Failure)
        }
        this.TornDown.push(tenantId)
    }
}

describe('ControlPlaneHost platform routes', () =>
{
    let host: ControlPlaneHost
    let fake: FakeProvisioning
    let parent: string
    let factory: FakeKindFactory
    let idp: FakeIdpService
    let deployments: PlatformDeploymentRegistry
    let statements: TestEntitlements

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-platform-'))
        const root = join(parent, 'static')
        mkdirSync(root)
        writeFileSync(join(root, 'index.html'), '<h1>portal</h1>')
        const directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        await directory.RecordClient({ id: 'acme', displayName: 'Acme' })
        factory = new FakeKindFactory()
        deployments = await RolloutFixture.Create(parent, directory, factory)
        const sessions = await HostSessions.With(FakeOperator.Token, FakeOperator.Principal())
        host = new ControlPlaneHost({ Service: {} as IEnvironmentService, Graphs: {} as IGraphService, PortalRoot: root, Operator: new FakeOperator(), Sessions: sessions.Sessions,
            Directory: directory, Entitlements: TestEntitlements.Gate(directory, statements = new TestEntitlements()), Deployments: deployments, Provisioning: (fake = new FakeProvisioning(directory)).AsService(), Observations: RolloutFixture.Observations(parent),
            Idp: (idp = new FakeIdpService()) })
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('challenges an unauthenticated clients request with 401', async () =>
    {
        assert.equal((await Harness.Send(host, 'GET', '/api/clients', undefined, false)).status, 401)
    })

    it('operators cannot create, edit or delete clients (405: the client routes are read-only)', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', '/api/clients', { id: 'globex', displayName: 'Globex' })).status, 405)
        assert.equal((await Harness.Send(host, 'PUT', '/api/clients/acme', { id: 'acme', displayName: 'Renamed' })).status, 405)
        assert.equal((await Harness.Send(host, 'DELETE', '/api/clients/acme')).status, 405)
        const list = JSON.parse((await Harness.Send(host, 'GET', '/api/clients')).body)
        assert.deepEqual(list.map((c: { id: string, displayName: string }) => [c.id, c.displayName]), [['acme', 'Acme']])
    })

    it('the client view shows plan, state, limits and version, never a price', async () =>
    {
        statements.State('acme', { State: EntitlementState.Suspended, Limits: { 'tenants': 2, 'hives': 3 } })
        const one = JSON.parse((await Harness.Send(host, 'GET', '/api/clients/acme')).body)
        assert.deepEqual(Object.keys(one.entitlement).sort(), ['admins', 'issuedAt', 'limits', 'planId', 'state', 'version'])
        assert.equal(one.entitlement.state, EntitlementState.Suspended)
        assert.deepEqual(one.entitlement.limits, { 'tenants': 2, 'hives': 3 })
        assert.equal(one.entitlement.version, 1)
        assert.deepEqual(one.entitlement.admins, [{ issuer: EntitlementSamples.Issuer, subject: EntitlementSamples.AdminSubject, email: EntitlementSamples.AdminEmail }])
        assert.ok(!/price|amount|currency|paddle|subscription/i.test(JSON.stringify(one)))
        assert.deepEqual(JSON.parse((await Harness.Send(host, 'GET', '/api/clients')).body)[0].entitlement, one.entitlement)
        statements.State('acme', undefined)
        assert.equal(JSON.parse((await Harness.Send(host, 'GET', '/api/clients/acme')).body).entitlement, undefined)
    })

    it('an operator creating a tenant or a hive for a client at its limit is refused with not-entitled limit-reached', async () =>
    {
        statements.State('acme', { Limits: { 'tenants': 1, 'hives': 0 } })
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })).status, 201)
        const tenant = await Harness.Send(host, 'POST', '/api/tenants', { id: 't2', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })
        assert.equal(tenant.status, 403)
        assert.deepEqual([JSON.parse(tenant.body).code, JSON.parse(tenant.body).reason], ['not-entitled', 'limit-reached'])
        const hive = await Harness.Send(host, 'POST', '/api/hives', { id: 'h1', tenantId: 't1', displayName: 'H', cluster: { backend: 'local', mode: 'provision' }, registry: { mode: 'provision' } })
        assert.equal(hive.status, 403)
        assert.deepEqual([JSON.parse(hive.body).code, JSON.parse(hive.body).reason], ['not-entitled', 'limit-reached'])
        assert.equal(JSON.parse((await Harness.Send(host, 'GET', '/api/hives')).body).length, 0)
        statements.State('acme', { State: EntitlementState.Suspended, Limits: { 'tenants': 5 } })
        assert.equal(JSON.parse((await Harness.Send(host, 'POST', '/api/tenants', { id: 't3', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })).body).reason, 'suspended')
    })

    it('provisions a tenant and reveals the one-time Owner password with no-store', async () =>
    {
        const r = await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })
        assert.equal(r.status, 201)
        assert.equal(r.cacheControl, 'no-store')
        const body = JSON.parse(r.body)
        assert.equal(body.id, 't1')
        assert.deepEqual(body.owner, { email: 'o@x.test', principalId: 'owner', password: FakeProvisioning.Password })
    })

    it('POST /api/tenants answers 201 with owner {email, principalId} and no password in in-hive mode', async () =>
    {
        fake.RecordOnly = true
        const r = await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })
        assert.equal(r.status, 201)
        const body = JSON.parse(r.body)
        assert.deepEqual(body.owner, { email: 'o@x.test', principalId: 'owner' })
        assert.equal(r.body.includes('password'), false)
    })

    it('rejects a tenant create without ownerEmail or with a reserved _ id', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T' })).status, 400)
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: '' })).status, 400)
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', { id: '_sys', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })).status, 400)
        assert.equal(fake.Calls.length, 0)
    })

    it('maps provisioning failures to 400 and 409', async () =>
    {
        const body = { id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' }
        fake.FailWith = new InvalidTenantIdError('bad id')
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', body)).status, 400)
        fake.FailWith = new RecordExistsError(RecordKind.Tenant, 't1')
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', body)).status, 409)
    })

    it('answers 503 with the plain message when there is no Docker/cluster target (D28 interim)', async () =>
    {
        fake.FailWith = new NoInfraTargetError()
        const r = await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })
        assert.equal(r.status, 503)
        assert.deepEqual(JSON.parse(r.body), { error: 'no Docker/cluster target configured' })
    })

    it('maps a cascade violation to 409 and an unknown parent to 404', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })).status, 201)
        assert.equal((await Harness.Send(host, 'DELETE', '/api/clients/acme')).status, 405)
        assert.equal((await Harness.Send(host, 'POST', '/api/tenants', { id: 't2', clientId: 'nope', displayName: 'T', ownerEmail: 'o@x.test' })).status, 404)
        const hive = { id: 'h1', tenantId: 't1', displayName: 'H', cluster: { backend: 'local', mode: 'provision' }, registry: { mode: 'provision' } }
        assert.equal((await Harness.Send(host, 'POST', '/api/hives', hive)).status, 201)
        assert.equal((await Harness.Send(host, 'DELETE', '/api/tenants/t1')).status, 409)
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/h1')).status, 200)
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/h1')).status, 200)
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/h1')).status, 404)
        assert.equal((await Harness.Send(host, 'POST', '/api/hives', { ...hive, cluster: { backend: 'bogus', mode: 'provision' } })).status, 400)
    })

    it('deleting a tenant tears down its IdP; the hives guard precedes; a teardown failure leaves the record', async () =>
    {
        await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })
        const hive = { id: 'h1', tenantId: 't1', displayName: 'H', cluster: { backend: 'local', mode: 'provision' }, registry: { mode: 'provision' } }
        await Harness.Send(host, 'POST', '/api/hives', hive)
        assert.equal((await Harness.Send(host, 'DELETE', '/api/tenants/t1')).status, 409)
        assert.deepEqual(idp.TornDown, [])
        await Harness.Send(host, 'DELETE', '/api/hives/h1')
        idp.Fail = true
        assert.equal((await Harness.Send(host, 'DELETE', '/api/tenants/t1')).status, 500)
        assert.equal((await Harness.Send(host, 'GET', '/api/tenants/t1')).status, 200)
        assert.deepEqual(fake.Forgotten, [], 'a failed delete keeps the tenant and its sessions')
        idp.Fail = false
        assert.equal((await Harness.Send(host, 'DELETE', '/api/tenants/t1')).status, 200)
        assert.deepEqual(idp.TornDown, ['t1'])
        // ForgetTenant ends the tenant's sessions (both kinds) and closes its relays and sockets.
        assert.deepEqual(fake.Forgotten, ['t1'])
        assert.equal((await Harness.Send(host, 'GET', '/api/tenants/t1')).status, 404)
    })

    it('deleting a tenant with no IdP record is a no-op teardown and still succeeds', async () =>
    {
        await Harness.Send(host, 'POST', '/api/tenants', { id: 't2', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })
        assert.equal((await Harness.Send(host, 'DELETE', '/api/tenants/t2')).status, 200)
        assert.deepEqual(idp.TornDown, ['t2'])
    })

    it('deleting a Provision-mode hive destroys its cluster; a destroy failure leaves the record', async () =>
    {
        await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })
        const hive = { id: 'h1', tenantId: 't1', displayName: 'H', cluster: { backend: 'local', mode: 'provision' }, registry: { mode: 'provision' } }
        await Harness.Send(host, 'POST', '/api/hives', hive)
        factory.FailWith = new Error('kind down')
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/h1')).status, 500)
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/h1')).status, 200)
        factory.FailWith = undefined
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/h1')).status, 200)
        assert.deepEqual(factory.Deleted, ['hive-h1'])
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/h1')).status, 404)
    })

    it('deleting an Attach-mode hive never destroys a cluster', async () =>
    {
        await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })
        await Harness.Send(host, 'POST', '/api/hives', { id: 'h2', tenantId: 't1', displayName: 'H', cluster: { backend: 'local', mode: 'attach' }, registry: { mode: 'attach' } })
        assert.equal((await Harness.Send(host, 'DELETE', '/api/hives/h2')).status, 200)
        assert.deepEqual(factory.Deleted, [])
    })

    it('POST /api/provision as Full operator -> 201 with records and both secrets', async () =>
    {
        const r = await Harness.Send(host, 'POST', '/api/provision', Harness.ProvisionBody())
        assert.equal(r.status, 201)
        assert.equal(r.cacheControl, 'no-store')
        const body = JSON.parse(r.body)
        assert.equal(body.client.id, 'acme')
        assert.equal(body.tenant.id, 't1')
        assert.equal(body.hive.id, 'h1')
        assert.ok(body.secrets.ownerPassword.length > 0)
        assert.ok(body.secrets.agentToken.length > 0)
        const fetched = await Harness.Send(host, 'GET', '/api/tenants/t1')
        assert.equal(fetched.status, 200)
        assert.ok(!fetched.body.includes(body.secrets.ownerPassword))
        assert.ok(!fetched.body.includes(body.secrets.agentToken))
    })

    it('POST /api/provision with a new client -> 400 and zero writes (the clients ledger owns clients)', async () =>
    {
        const body = Harness.ProvisionBody()
        body.client = { id: 'globex', displayName: 'Globex' }
        const r = await Harness.Send(host, 'POST', '/api/provision', body)
        assert.equal(r.status, 400)
        assert.equal(JSON.parse((await Harness.Send(host, 'GET', '/api/tenants')).body).length, 0)
        assert.equal(JSON.parse((await Harness.Send(host, 'GET', '/api/clients')).body).length, 1)
    })

    it('POST /api/provision onto an existing client and tenant -> 201, hive created, no Owner secrets', async () =>
    {
        await Harness.Send(host, 'POST', '/api/tenants', { id: 't1', clientId: 'acme', displayName: 'T', ownerEmail: 'o@x.test' })
        const body = Harness.ProvisionBody()
        body.client = { existing: true, id: 'acme' }
        body.tenant = { existing: true, id: 't1' }
        const r = await Harness.Send(host, 'POST', '/api/provision', body)
        assert.equal(r.status, 201)
        const result = JSON.parse(r.body)
        assert.equal(result.hive.tenantId, 't1')
        assert.equal(result.secrets.ownerPassword, undefined)
        assert.ok(result.secrets.agentToken.length > 0)
        assert.equal(JSON.parse((await Harness.Send(host, 'GET', '/api/clients')).body).length, 1)
    })

    it('POST /api/provision with a non-boolean existing flag -> 400', async () =>
    {
        const bad = Harness.ProvisionBody()
        bad.client = { existing: 'yes', id: 'acme' }
        const r = await Harness.Send(host, 'POST', '/api/provision', bad)
        assert.equal(r.status, 400)
    })

    it('GET /api/hives/ID/bootstrap while the agent channel is off -> 409 naming the setting', async () =>
    {
        await Harness.Send(host, 'POST', '/api/provision', Harness.ProvisionBody())
        const r = await Harness.Send(host, 'GET', '/api/hives/h1/bootstrap')
        assert.equal(r.status, 409)
        assert.match(JSON.parse(r.body).error, /PRAGMATIC_AGENT_CHANNEL_PORT/)
    })

    it('POST /api/hives/ID/rollout-registration replaces the agent token: the new one verifies, the old one no longer does', async () =>
    {
        const provisioned = JSON.parse((await Harness.Send(host, 'POST', '/api/provision', Harness.ProvisionBody())).body)
        const r = await Harness.Send(host, 'POST', '/api/hives/h1/rollout-registration')
        assert.equal(r.status, 201)
        assert.equal(r.cacheControl, 'no-store')
        const token = JSON.parse(r.body).token as string
        assert.ok(token.length > 0)
        assert.notEqual(token, provisioned.secrets.agentToken)
        await deployments.VerifyAgentToken('h1', token)
        await assert.rejects(() => deployments.VerifyAgentToken('h1', provisioned.secrets.agentToken))
    })

    it('POST /api/hives/ID/rollout-registration for an unknown hive -> 404 and nothing registered', async () =>
    {
        assert.equal((await Harness.Send(host, 'POST', '/api/hives/nope/rollout-registration')).status, 404)
        await assert.rejects(() => deployments.VerifyAgentToken('nope', 'x'))
    })

    it('POST /api/provision with an invalid cluster -> 400 and zero writes', async () =>
    {
        const bad = Harness.ProvisionBody()
        bad.hive.cluster = { backend: 'bogus', mode: 'provision' }
        const r = await Harness.Send(host, 'POST', '/api/provision', bad)
        assert.equal(r.status, 400)
        for (const path of ['/api/tenants', '/api/hives'])
        {
            assert.equal(JSON.parse((await Harness.Send(host, 'GET', path)).body).length, 0, path)
        }
        assert.equal(JSON.parse((await Harness.Send(host, 'GET', '/api/clients')).body).length, 1)
    })
})

describe('ControlPlaneHost hive bootstrap with the agent channel on', () =>
{
    let host: ControlPlaneHost
    let parent: string

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-bootstrap-'))
        const root = join(parent, 'static')
        mkdirSync(root)
        writeFileSync(join(root, 'index.html'), '<h1>portal</h1>')
        const directory = new PlatformDirectory(
            new ClientRegistry(join(parent, 'clients.json')),
            new TenantRegistry(join(parent, 'tenants.json')),
            new HiveRegistry(join(parent, 'hives.json')),
            { List: () => [] })
        await directory.Load()
        await directory.RecordClient({ id: 'acme', displayName: 'Acme' })
        const sessions = await HostSessions.With(FakeOperator.Token, FakeOperator.Principal())
        host = new ControlPlaneHost({ Service: {} as IEnvironmentService, Graphs: {} as IGraphService, PortalRoot: root, Operator: new FakeOperator(), Sessions: sessions.Sessions,
            Directory: directory, Entitlements: TestEntitlements.Gate(directory), Deployments: await RolloutFixture.Create(parent, directory, new FakeKindFactory()), Provisioning: new FakeProvisioning(directory).AsService(),
            Observations: RolloutFixture.Observations(parent), Idp: new FakeIdpService(), AgentChannelUrl: 'http://host.docker.internal:7001' })
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('GET /api/hives/ID/bootstrap -> the secret-free bundle pointed at the channel', async () =>
    {
        const provisioned = JSON.parse((await Harness.Send(host, 'POST', '/api/provision', Harness.ProvisionBody())).body)
        const r = await Harness.Send(host, 'GET', '/api/hives/h1/bootstrap')
        assert.equal(r.status, 200)
        const bundle = JSON.parse(r.body)
        assert.equal(bundle.hiveId, 'h1')
        assert.equal(bundle.channelUrl, 'http://host.docker.internal:7001')
        assert.equal(bundle.tokenSecretName, 'pragmatic-hive-h1-agent-token')
        assert.equal(bundle.hiveSelector, 'pragmatic/hive=h1')
        assert.ok(!r.body.includes(provisioned.secrets.agentToken))
    })

    it('GET /api/hives/ID/bootstrap for an unknown hive -> 404, for a malformed id -> 404 (no route matches)', async () =>
    {
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/nope/bootstrap')).status, 404)
        // Ruling (pipeline behaviour changes): a route parameter that does not percent-decode matches no route (404; was 400).
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/%E0%A4%A/bootstrap')).status, 404)
    })
})
