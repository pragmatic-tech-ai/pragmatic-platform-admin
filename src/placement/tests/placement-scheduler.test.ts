import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HiveLevel as CustomerHiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { ConsoleAddress, ConsoleAddressOption, HiveLevel, HostHealth, PlacementOperation } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeHiveAgent } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { EnrolmentCodeRefusal, EnrolmentCodeRefusedError } from '../../enrolment/enrolment-code-issuer.js'
import { EnrolmentAgentKind } from '../../enrolment/enrolment-code-record.js'
import { HostRegistry } from '../../hosts/host-registry.js'
import { HostWorld } from '../../hosts/tests/host-world.js'
import { PlacementQueue } from '../placement-queue.js'
import { PlacementState } from '../placement-record.js'

class SchedulerCases
{
    public static readonly LabelPattern = /^acme-[a-z2-7]{4}$/

    public static async Refusal(work: Promise<unknown>): Promise<EnrolmentCodeRefusal>
    {
        try
        {
            await work
        }
        catch (error)
        {
            assert.ok(error instanceof EnrolmentCodeRefusedError)
            return error.Reason
        }
        throw new Error('expected a refusal')
    }
}

describe('PlacementScheduler', () =>
{
    const C = SchedulerCases
    it('schedules onto the freest fresh host', async () =>
    {
        const world = await HostWorld.Create()
        const small = await world.ReportingHost(2, 'small')
        world.Clock.Advance(1000)
        const big = await world.ReportingHost(4, 'big')
        const first = await world.Request()
        await world.Scheduler.Tick()
        assert.equal(world.Placement(first.id).hostId, big.Self.Id)
        assert.equal(world.Placement(first.id).state, PlacementState.Scheduled)
        // big now has 3 free, small 2: the next goes to big again; then both 2 free, the freshest (big) wins.
        const second = await world.Request()
        const third = await world.Request()
        await world.Scheduler.Tick()
        assert.equal(world.Placement(second.id).hostId, big.Self.Id)
        assert.equal(world.Placement(third.id).hostId, big.Self.Id)
        const fourth = await world.Request()
        await world.Scheduler.Tick()
        assert.equal(world.Placement(fourth.id).hostId, small.Self.Id, 'big has 1 free, small 2')
    })

    it('skips full and stale hosts and leaves the placement requested', async () =>
    {
        const world = await HostWorld.Create()
        const agent = await world.ReportingHost(1)
        const first = await world.Request()
        const second = await world.Request()
        await world.Scheduler.Tick()
        assert.equal(world.Placement(first.id).state, PlacementState.Scheduled)
        assert.equal(world.Placement(second.id).state, PlacementState.Requested, 'the only host is full')
        const other = await world.ReportingHost(4, 'other')
        world.Clock.Advance(HostRegistry.FreshMs + 1)
        await world.Scheduler.Tick()
        assert.equal(world.Placement(second.id).state, PlacementState.Requested, 'the free host is stale')
        await other.Report(HostWorld.Report(4, HostHealth.Unavailable))
        await world.Scheduler.Tick()
        assert.equal(world.Placement(second.id).state, PlacementState.Requested, 'a host taking no placements is skipped')
        await other.Report(HostWorld.Report(4))
        await world.Scheduler.Tick()
        assert.equal(world.Placement(second.id).hostId, other.Self.Id)
        assert.ok(agent.Enrolled)
    })

    it('waits while the platform offers the tenant no release with a chart', async () =>
    {
        const world = await HostWorld.Create()
        await world.ReportingHost()
        world.Releases.Offered = undefined
        const placement = await world.Request()
        await world.Scheduler.Tick()
        assert.equal(world.Placement(placement.id).state, PlacementState.Requested)
        assert.equal(world.Queue().length, 0)
    })

    it('publishes a signed place request with the label, the hive host name, the engine version and the chart digest', async () =>
    {
        const world = await HostWorld.Create()
        const agent = await world.ReportingHost()
        const placement = await world.Request()
        await world.Scheduler.Tick()
        const [item, ...rest] = await agent.PullPlacements()
        assert.equal(rest.length, 0)
        assert.ok(item !== undefined)
        const request = item.Body
        assert.equal(request.Operation, PlacementOperation.Place)
        assert.equal(request.PlacementId, placement.id)
        assert.equal(request.Tenant, HostWorld.TenantA)
        assert.equal(request.EngineVersion, HostWorld.EngineVersion)
        assert.equal(request.ChartDigest, HostWorld.ChartDigest)
        const record = world.Placement(placement.id)
        assert.match(record.label ?? '', C.LabelPattern)
        assert.equal(request.HiveHostName, record.label + '.' + ConsoleAddress.HiveDomain)
        assert.equal(record.requestSequence, world.Host(agent).lastSequence)
        assert.equal((await agent.PullPlacements()).length, 0, 'the cursor moved past it')
    })

    it('the hive code is bound to the tenant, level hosted and agent kind hive, and counts once', async () =>
    {
        const world = await HostWorld.Create()
        const agent = await world.ReportingHost()
        const placement = await world.Request()
        await world.Scheduler.Tick()
        const code = (await agent.PullPlacements())[0]?.Body.EnrolmentCode as string
        const record = world.CodeRecord(r => r.placementId === placement.id)
        assert.deepEqual([record?.tenantId, record?.level, record?.agentKind, record?.clientId], [HostWorld.TenantA, CustomerHiveLevel.Hosted, EnrolmentAgentKind.Hive, HostWorld.ClientId])
        assert.equal(world.Codes.OutstandingFor(HostWorld.ClientId, world.Clock.Now()), 0, 'the placement reserves the hive, not its code')
        assert.equal(world.Placements.OutstandingFor(HostWorld.ClientId, world.Clock.Now()), 1)
        const expect = { TenantId: HostWorld.TenantA, Level: CustomerHiveLevel.Hosted, AgentKind: EnrolmentAgentKind.Hive }
        assert.equal(await C.Refusal(world.Codes.Redeem(code, { ...expect, TenantId: HostWorld.TenantB })), EnrolmentCodeRefusal.Mismatch)
        assert.equal(await C.Refusal(world.Codes.Redeem(code, { ...expect, Level: CustomerHiveLevel.Enrolled })), EnrolmentCodeRefusal.Mismatch)
        assert.equal(await C.Refusal(world.Codes.Redeem(code, { ...expect, AgentKind: EnrolmentAgentKind.Host })), EnrolmentCodeRefusal.Mismatch)
        const hive = new FakeHiveAgent(world.Channel, world.Clock, world.TrustRoot.PublicKey)
        const response = await hive.Enrol(code, HostWorld.TenantA, HiveLevel.Hosted, ConsoleAddress.RelayedHiveSubdomain(world.Placement(placement.id).label as string))
        assert.equal(world.Placement(placement.id).hiveId, response.HiveId)
        assert.equal(world.Placements.OutstandingFor(HostWorld.ClientId, world.Clock.Now()), 0, 'its hive counts instead')
    })

    it('a placed hive offered a newer release is upgraded as a new placement version whose code can enrol nothing', async () =>
    {
        const world = await HostWorld.Create()
        const agent = await world.ReportingHost()
        const placement = await world.Request()
        await world.Scheduler.Tick()
        await agent.PullPlacements()
        await world.Placements.MarkPlaced(placement.id, { host: 'hive-laptop.mesh.pragmatic.test', port: 16444 })
        await world.Scheduler.Tick()
        assert.equal((await agent.PullPlacements()).length, 0, 'the same release: nothing to do')
        world.Releases.Offered = { Version: HostWorld.NewerVersion, ChartDigest: HostWorld.NewerChartDigest }
        await world.Scheduler.Tick()
        const [upgrade] = await agent.PullPlacements()
        assert.equal(upgrade?.Body.Operation, PlacementOperation.Place)
        assert.equal(upgrade?.Body.EngineVersion, HostWorld.NewerVersion)
        assert.equal(upgrade?.Body.ChartDigest, HostWorld.NewerChartDigest)
        assert.equal(world.Placement(placement.id).version, 2)
        const code = upgrade?.Body.EnrolmentCode as string
        assert.equal(await C.Refusal(world.Codes.Redeem(code, { TenantId: HostWorld.TenantA, Level: CustomerHiveLevel.Hosted, AgentKind: EnrolmentAgentKind.Hive })), EnrolmentCodeRefusal.Used)
        world.Releases.Offered = { Version: HostWorld.EngineVersion, ChartDigest: HostWorld.ChartDigest }
        await world.Scheduler.Tick()
        assert.equal((await agent.PullPlacements()).length, 0, 'never a downgrade')
    })

    it('a request that expired unpulled is published again', async () =>
    {
        const world = await HostWorld.Create()
        const agent = await world.ReportingHost()
        const placement = await world.Request()
        await world.Scheduler.Tick()
        const first = world.Placement(placement.id).requestSequence as number
        world.Clock.Advance(8 * 24 * 60 * 60 * 1000)
        await agent.Report(HostWorld.Report())
        await world.Scheduler.Tick()
        assert.ok((world.Placement(placement.id).requestSequence as number) > first)
        const items = await agent.PullPlacements()
        assert.equal(items.length, 1)
        assert.equal(items[0]?.Body.PlacementId, placement.id)
    })

    it('a placement pulled 40 min after publish still enrols (its code lives as long as its request)', async () =>
    {
        const world = await HostWorld.Create()
        const agent = await world.ReportingHost()
        const placement = await world.Request()
        await world.Scheduler.Tick()
        world.Clock.Advance(40 * 60 * 1000)
        const request = (await agent.PullPlacements())[0]?.Body
        assert.ok(request !== undefined)
        const hive = new FakeHiveAgent(world.Channel, world.Clock, world.TrustRoot.PublicKey)
        const response = await hive.Enrol(request.EnrolmentCode as string, HostWorld.TenantA, HiveLevel.Hosted, ConsoleAddress.RelayedHiveSubdomain(world.Placement(placement.id).label as string))
        assert.equal(world.Placement(placement.id).hiveId, response.HiveId)
        const record = world.CodeRecord(r => r.placementId === placement.id)
        assert.equal(Date.parse(record?.expiresAt ?? '') - Date.parse(record?.issuedAt ?? ''), PlacementQueue.RequestLifetimeMs)
    })

    it('restore, publish two, pull with the old cursor delivers both', async () =>
    {
        const world = await HostWorld.Create()
        const agent = await world.ReportingHost(4)
        await world.Request()
        await world.Request()
        await world.Scheduler.Tick()
        assert.equal((await agent.PullPlacements()).length, 2, 'the host\'s cursor is past both')
        // A restore from an older backup: the queue and the host's last sequence are back to before these.
        const host = world.Host(agent)
        for (const row of world.Queue())
        {
            await world.QueueStore.Remove(row.id)
        }
        await world.HostStore.Put({ ...host, lastSequence: 0 })
        for (const placement of world.Placements.List())
        {
            await world.Placements.BeginRemoval(placement.id)
            await world.Placements.MarkRemoved(placement.id)
        }
        world.Clock.Advance(60_000)
        await agent.Report(HostWorld.Report(4))
        const third = await world.Request()
        const fourth = await world.Request()
        await world.Scheduler.Tick()
        const pulled = (await agent.PullPlacements()).map(item => item.Body.PlacementId).sort()
        assert.deepEqual(pulled, [third.id, fourth.id].sort())
    })

    it('a new label never takes one an enrolled hive\'s console answers at', async () =>
    {
        const world = await HostWorld.Create()
        await world.ReportingHost()
        // Every random draw spells "aaaa" first, then "bbbb".
        let draw = 0
        world.Random = (size: number) => Buffer.alloc(size, draw++ === 0 ? 0 : 1)
        await world.Directory.EnrolHive({
            id: 'hvaaaaaaaaaa', tenantId: HostWorld.TenantA, level: HostWorld.HostedLevel, publicKey: 'k', keyId: 'kid', engineVersion: '0.1.0',
            consoleAddress: { Option: ConsoleAddressOption.RelayedHiveSubdomain, Host: 'acme-aaaa.' + ConsoleAddress.HiveDomain, IngressAddress: null }, enrolledBy: 'x',
        })
        const placement = await world.Request()
        await world.Scheduler.Tick()
        assert.equal(world.Placement(placement.id).label, 'acme-bbbb')
    })
})
