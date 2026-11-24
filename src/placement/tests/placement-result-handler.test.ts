import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HiveBackend, InfraMode } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { AgentExchangeRefusal, ApiServerAddress, ClusterCredentialHandover, ConsoleAddress, HiveLevel, PlacementFailure, PlacementOperation, PlacementResult } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeHiveAgent, type FakeHostAgent } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { WorldRefusalError } from '../../hive-channel/tests/hive-channel-world.js'
import { HostWorld } from '../../hosts/tests/host-world.js'
import type { PlatformHiveRecord } from '../../platform-records.js'
import { PlacementState } from '../placement-record.js'

class ResultCases
{
    public static readonly ApiServer = new ApiServerAddress('hive-laptop.mesh.pragmatic.test', 16444)
    public static readonly Kubeconfig = Buffer.from('apiVersion: v1\nkind: Config\nclusters: []\n')

    /** A placement scheduled on a fresh host, its place request pulled: the host agent, the placement id and the hive code. */
    public static async Pulled(): Promise<{ World: HostWorld; Agent: FakeHostAgent; Id: string; Code: string; Label: string }>
    {
        const world = await HostWorld.Create()
        const agent = await world.ReportingHost()
        const placement = await world.Request()
        await world.Scheduler.Tick()
        const request = (await agent.PullPlacements())[0]?.Body
        assert.ok(request !== undefined)
        return { World: world, Agent: agent, Id: placement.id, Code: request.EnrolmentCode as string, Label: world.Placement(placement.id).label as string }
    }

    public static async EnrolHive(world: HostWorld, code: string, label: string): Promise<string>
    {
        const hive = new FakeHiveAgent(world.Channel, world.Clock, world.TrustRoot.PublicKey)
        return (await hive.Enrol(code, HostWorld.TenantA, HiveLevel.Hosted, ConsoleAddress.RelayedHiveSubdomain(label))).HiveId
    }

    public static AssertAttached(world: HostWorld, hiveId: string, placementId: string): void
    {
        const hive = world.Directory.GetHive(hiveId) as PlatformHiveRecord
        assert.deepEqual(hive.cluster, { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: ClusterCredentialHandover.ReferenceFor(placementId) })
        assert.equal(hive.placementId, placementId)
        assert.equal(hive.level, HostWorld.HostedLevel)
    }

    public static async CodeOf(work: Promise<unknown>): Promise<AgentExchangeRefusal>
    {
        try
        {
            await work
        }
        catch (error)
        {
            if (error instanceof WorldRefusalError)
            {
                return error.Code
            }
            throw error
        }
        throw new Error('expected a refusal')
    }
}

describe('PlacementResultHandler', () =>
{
    const C = ResultCases
    it('placed links the hive record to its credential reference (the hive enrolled first)', async () =>
    {
        const { World, Agent, Id, Code, Label } = await C.Pulled()
        const hiveId = await C.EnrolHive(World, Code, Label)
        assert.equal((World.Directory.GetHive(hiveId) as PlatformHiveRecord).cluster.backend, HiveBackend.Private, 'not placed yet: not pushable')
        await Agent.HandOver(Id, 1, C.Kubeconfig, new Date(World.Clock.Now().getTime() + 86_400_000))
        await Agent.Result(PlacementResult.Placed(Id, C.ApiServer))
        const placement = World.Placement(Id)
        assert.equal(placement.state, PlacementState.Placed)
        assert.deepEqual(placement.apiServer, { host: C.ApiServer.Host, port: C.ApiServer.Port })
        C.AssertAttached(World, hiveId, Id)
    })

    it('placed links the hive record to its credential reference (the placed result first)', async () =>
    {
        const { World, Agent, Id, Code, Label } = await C.Pulled()
        await Agent.Result(PlacementResult.Placed(Id, C.ApiServer))
        await Agent.Result(PlacementResult.Placed(Id, C.ApiServer))
        assert.equal(World.Placement(Id).state, PlacementState.Placed, 'a retried result changes nothing')
        const hiveId = await C.EnrolHive(World, Code, Label)
        C.AssertAttached(World, hiveId, Id)
    })

    it('failed marks the placement failed with the code and frees its slot', async () =>
    {
        const world = await HostWorld.Create()
        const agent = await world.ReportingHost(1)
        const first = await world.Request()
        const second = await world.Request()
        await world.Scheduler.Tick()
        assert.equal(world.Placement(second.id).state, PlacementState.Requested)
        await agent.Result(PlacementResult.Failed(first.id, PlacementFailure.ClusterCreateFailed))
        assert.equal(world.Placement(first.id).state, PlacementState.Failed)
        assert.equal(world.Placement(first.id).failure, PlacementFailure.ClusterCreateFailed)
        await world.Scheduler.Tick()
        assert.equal(world.Placement(second.id).state, PlacementState.Scheduled, 'the freed slot takes the next placement')
    })

    it('leave publishes a removal and, on removed, deletes the credential', async () =>
    {
        const { World, Agent, Id, Code, Label } = await C.Pulled()
        await Agent.HandOver(Id, 1, C.Kubeconfig, new Date(World.Clock.Now().getTime() + 86_400_000))
        await Agent.Result(PlacementResult.Placed(Id, C.ApiServer))
        await C.EnrolHive(World, Code, Label)
        await World.Placements.BeginRemoval(Id)
        await World.Scheduler.Tick()
        const [removal] = await Agent.PullPlacements()
        assert.equal(removal?.Body.Operation, PlacementOperation.Remove)
        assert.equal(removal?.Body.PlacementId, Id)
        assert.equal(World.Placement(Id).state, PlacementState.Removing)
        assert.ok(await World.Sealed.Get(ClusterCredentialHandover.ReferenceFor(Id)) !== undefined)
        await Agent.Result(PlacementResult.Removed(Id))
        assert.equal(World.Placement(Id).state, PlacementState.Removed)
        assert.equal(await World.Sealed.Get(ClusterCredentialHandover.ReferenceFor(Id)), undefined)
        await Agent.Result(PlacementResult.Removed(Id))
        await Agent.Result(PlacementResult.Removed('pl-unknownunknown12'))
        assert.equal(World.Placements.HoldingSlotOn(Agent.Self.Id).length, 0)
    })

    it('a result for another host\'s placement, or a placed one for an unknown placement, is refused', async () =>
    {
        const { World, Id } = await C.Pulled()
        const other = await World.ReportingHost(4, 'other')
        assert.equal(await C.CodeOf(other.Result(PlacementResult.Placed(Id, C.ApiServer))), AgentExchangeRefusal.Mismatch)
        assert.equal(await C.CodeOf(other.Result(PlacementResult.Removed(Id))), AgentExchangeRefusal.Mismatch)
        assert.equal(await C.CodeOf(other.Result(PlacementResult.Placed('pl-unknownunknown12', C.ApiServer))), AgentExchangeRefusal.Mismatch)
        assert.equal(World.Placement(Id).state, PlacementState.Scheduled)
    })

    it('a code of a removed placement enrols nothing', async () =>
    {
        const { World, Agent, Id, Code, Label } = await C.Pulled()
        await World.Placements.BeginRemoval(Id)
        await Agent.Result(PlacementResult.Removed(Id))
        assert.equal(await C.CodeOf(C.EnrolHive(World, Code, Label)), AgentExchangeRefusal.Mismatch)
        assert.equal(World.Directory.ListHives().length, 0)
    })
})
