import { TestEntitlements } from './test-entitlements.js'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { FakeProvisioning } from './fake-provisioning.js'
import { ControlPlaneHost } from '../control-plane-host.js'
import { type IEnvironmentService, type IGraphService, type HiveRecord, type IHiveOrchestrator, HiveBackend, InfraMode } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSummary } from '../operator-identity.js'
import { HostSessions } from './host-sessions.js'
import { RolloutFixture } from './rollout-fixture.js'
import { HiveLevel as CustomerHiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { HiveLevel, SigningKeyPair } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeHiveAgent } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { HiveChannelWorld } from '../hive-channel/tests/hive-channel-world.js'
import { OperatorIntentRoutes, type OperatorIntentDto } from '../intents/operator-intent-routes.js'
import { RolloutIntents } from '../intents/rollout-intents.js'
import { HiveAgentUninstaller } from '../hive-agent-uninstaller.js'
import { PlatformHiveOrchestratorFactory } from '../platform-hive-orchestrator-factory.js'

type Reply = { status: number; body: string }

class FakeOperator implements IOperatorIdentity
{
    public static readonly Token = 'valid-token'
    public static readonly Email = 'op@example.com'
    public static readonly PrincipalId = 'p1'

    public Role: OperatorRole = OperatorRole.Full

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
        return { email: FakeOperator.Email, principalId, role: this.Role }
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
    public static Send(host: ControlPlaneHost, method: string, path: string, body?: unknown, authed: boolean = true): Promise<Reply>
    {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (authed)
        {
            headers.cookie = 'cp_session=' + FakeOperator.Token
        }
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
            })
            req.on('error', reject)
            req.end(body === undefined ? undefined : JSON.stringify(body))
        })
    }
}


/** An orchestrator factory that counts every push it is asked for. */
class CountingFactory extends PlatformHiveOrchestratorFactory
{
    public Calls = 0

    public override For(hive: HiveRecord): IHiveOrchestrator
    {
        this.Calls += 1
        return super.For(hive)
    }
}

describe('ControlPlaneHost intent routes (C3.4)', () =>
{
    const CreateProd = { Kind: 'create-environment', Environment: 'prod', Purpose: 'runtime', Version: null }
    let host: ControlPlaneHost
    let parent: string
    let world: HiveChannelWorld
    let hiveId: string
    let factory: CountingFactory

    beforeEach(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'cp-intents-'))
        const root = join(parent, 'static')
        mkdirSync(root)
        writeFileSync(join(root, 'index.html'), '<h1>portal</h1>')
        world = await HiveChannelWorld.Create()
        const agent = new FakeHiveAgent(world.Channel, world.Clock, world.TrustRoot.PublicKey)
        await agent.Enrol(await world.IssueCode(HiveChannelWorld.TenantA, CustomerHiveLevel.Enrolled), HiveChannelWorld.TenantA, HiveLevel.Enrolled)
        hiveId = agent.Self.Id
        await world.Directory.CreateHive({ id: 'hosted1', tenantId: HiveChannelWorld.TenantB, displayName: 'H', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Provision } })
        factory = new CountingFactory(undefined, parent)
        const deployments = await RolloutFixture.Create(parent, world.Directory, factory, new RolloutIntents(world.Publisher, world.Intents))
        const sessions = await HostSessions.With(FakeOperator.Token, FakeOperator.Principal())
        host = new ControlPlaneHost({ Service: {} as IEnvironmentService, Graphs: {} as IGraphService, PortalRoot: root, Operator: new FakeOperator(), Sessions: sessions.Sessions,
            Directory: world.Directory, Entitlements: TestEntitlements.Gate(world.Directory), Deployments: deployments, Provisioning: new FakeProvisioning(world.Directory).AsService(),
            Observations: RolloutFixture.Observations(parent), Intents: new OperatorIntentRoutes(world.Publisher, world.Intents, deployments),
            AgentUninstaller: new HiveAgentUninstaller(factory) })
        await host.Listen(0, '127.0.0.1')
    })

    afterEach(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('operator create-environment on an enrolled hive publishes create-environment instead of applying, and lists it', async () =>
    {
        const published = await Harness.Send(host, 'POST', '/api/hives/' + hiveId + '/intents', { action: CreateProd, lifetimeDays: 1 })
        assert.equal(published.status, 201)
        const dto = JSON.parse(published.body) as OperatorIntentDto
        assert.deepEqual([dto.level, dto.action, dto.progress, dto.publishedBy], ['enrolled', CreateProd, null, 'operator:' + FakeOperator.Email])
        assert.ok(!published.body.includes('Signature'))
        const listed = JSON.parse((await Harness.Send(host, 'GET', '/api/hives/' + hiveId + '/intents')).body) as { intents: OperatorIntentDto[] }
        assert.deepEqual(listed.intents.map(intent => intent.id), [dto.id])
        assert.equal(world.Intents.ForHive(hiveId).length, 1)
    })

    it('a hosted hive is refused hive-takes-no-intents, a broken action malformed, an unknown hive 404', async () =>
    {
        const hosted = await Harness.Send(host, 'POST', '/api/hives/hosted1/intents', { action: CreateProd })
        assert.deepEqual([hosted.status, JSON.parse(hosted.body).code], [409, 'hive-takes-no-intents'])
        const broken = await Harness.Send(host, 'POST', '/api/hives/' + hiveId + '/intents', { action: { Kind: 'run-shell', Command: 'rm -rf /' } })
        assert.deepEqual([broken.status, JSON.parse(broken.body).code], [400, 'malformed'])
        const long = await Harness.Send(host, 'POST', '/api/hives/' + hiveId + '/intents', { action: CreateProd, lifetimeDays: 31 })
        assert.equal(long.status, 400)
        assert.equal((await Harness.Send(host, 'GET', '/api/hives/nohive/intents')).status, 404)
        const release = await Harness.Send(host, 'POST', '/api/hives/hosted1/release', { version: '0.1.0-early.20' })
        assert.deepEqual([release.status, JSON.parse(release.body).code], [409, 'hive-takes-no-intents'])
    })

    it('an expired intent is shown expired and reissued under a new id', async () =>
    {
        const published = JSON.parse((await Harness.Send(host, 'POST', '/api/hives/' + hiveId + '/intents', { action: CreateProd, lifetimeDays: 1 })).body) as OperatorIntentDto
        world.Clock.Advance(2 * 86_400_000)
        const reissued = await Harness.Send(host, 'POST', '/api/intents/' + published.id + '/reissue')
        assert.equal(reissued.status, 201)
        const listed = JSON.parse((await Harness.Send(host, 'GET', '/api/hives/' + hiveId + '/intents')).body) as { intents: OperatorIntentDto[] }
        const old = listed.intents.find(intent => intent.id === published.id)
        assert.equal(old?.expired, true)
        assert.equal(old?.supersededBy, (JSON.parse(reissued.body) as OperatorIntentDto).id)
        const again = await Harness.Send(host, 'POST', '/api/intents/' + published.id + '/reissue')
        assert.deepEqual([again.status, JSON.parse(again.body).code], [409, 'not-reissuable'])
    })

    it('a component version or a trust-root rotation is not published by hand', async () =>
    {
        const component = { Kind: 'component-at-version', Component: 'pragmatic-tenant-admin', Version: '0.1.13', ImageDigest: 'sha256:' + 'a'.repeat(64), DescriptorDigest: 'sha256:' + 'b'.repeat(64), Configuration: null }
        const root = { Kind: 'rotate', Subject: 'trust-root', NewTrustRoot: SigningKeyPair.Generate().PublicKey.ToJson() }
        for (const action of [component, root])
        {
            const reply = await Harness.Send(host, 'POST', '/api/hives/' + hiveId + '/intents', { action })
            assert.deepEqual([reply.status, JSON.parse(reply.body).code], [400, 'kind-not-allowed'])
        }
        const rotate = await Harness.Send(host, 'POST', '/api/hives/' + hiveId + '/intents', { action: { Kind: 'rotate', Subject: 'hive-key', NewTrustRoot: null } })
        assert.equal(rotate.status, 201)
        assert.equal(world.Intents.ForHive(hiveId).length, 1)
    })

    it('deleting an enrolled hive removes the record and never reaches into its cluster', async () =>
    {
        const deleted = await Harness.Send(host, 'DELETE', '/api/hives/' + hiveId)
        assert.ok(deleted.status === 200 || deleted.status === 204, deleted.body)
        assert.equal(world.Directory.GetHive(hiveId), undefined)
        assert.equal(factory.Calls, 0, 'no cluster step ran')
    })
})

