import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HiveBackend, InfraMode } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { AgentExchangeRefusal, ApiServerAddress, ClusterCredentialHandover, ConsoleAddress, EnvelopeSigner, HiveEnrolmentRequest, HiveEnrolmentResponse, HiveLevel, MessageKind, Participant, ParticipantRole, PlacementFailure, PlacementOperation, PlacementResult } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeHiveAgent, type FakeHostAgent } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { WorldRefusalError } from '../../hive-channel/tests/hive-channel-world.js'
import { HostKubeconfigs, HostWorld } from '../../hosts/tests/host-world.js'
import type { PlatformHiveRecord } from '../../platform-records.js'
import { PlacementState } from '../placement-record.js'

class ResultCases
{
    public static readonly ApiServer = new ApiServerAddress('hive-laptop.mesh.pragmatic.test', HostKubeconfigs.Port)
    public static readonly Kubeconfig = HostKubeconfigs.Valid()

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
        await Agent.Result(PlacementResult.Placed(Id, 1, C.ApiServer))
        const placement = World.Placement(Id)
        assert.equal(placement.state, PlacementState.Placed)
        assert.deepEqual(placement.apiServer, { host: C.ApiServer.Host, port: C.ApiServer.Port })
        C.AssertAttached(World, hiveId, Id)
    })

    it('placed links the hive record to its credential reference (the placed result first)', async () =>
    {
        const { World, Agent, Id, Code, Label } = await C.Pulled()
        await Agent.Result(PlacementResult.Placed(Id, 1, C.ApiServer))
        await Agent.Result(PlacementResult.Placed(Id, 1, C.ApiServer))
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
        await agent.Result(PlacementResult.Failed(first.id, 1, PlacementFailure.ClusterCreateFailed))
        assert.equal(world.Placement(first.id).state, PlacementState.Failed)
        assert.equal(world.Placement(first.id).failure, PlacementFailure.ClusterCreateFailed)
        await world.Scheduler.Tick()
        assert.equal(world.Placement(second.id).state, PlacementState.Scheduled, 'the freed slot takes the next placement')
    })

    it('leave publishes a removal and, on removed, deletes the credential', async () =>
    {
        const { World, Agent, Id, Code, Label } = await C.Pulled()
        await Agent.HandOver(Id, 1, C.Kubeconfig, new Date(World.Clock.Now().getTime() + 86_400_000))
        await Agent.Result(PlacementResult.Placed(Id, 1, C.ApiServer))
        await C.EnrolHive(World, Code, Label)
        await World.Placements.BeginRemoval(Id)
        await World.Scheduler.Tick()
        const [removal] = await Agent.PullPlacements()
        assert.equal(removal?.Body.Operation, PlacementOperation.Remove)
        assert.equal(removal?.Body.PlacementId, Id)
        assert.equal(World.Placement(Id).state, PlacementState.Removing)
        assert.ok(await World.Sealed.Get(ClusterCredentialHandover.ReferenceFor(Id)) !== undefined)
        await Agent.Result(PlacementResult.Removed(Id, 2))
        assert.equal(World.Placement(Id).state, PlacementState.Removed)
        assert.equal(await World.Sealed.Get(ClusterCredentialHandover.ReferenceFor(Id)), undefined)
        await Agent.Result(PlacementResult.Removed(Id, 2))
        await Agent.Result(PlacementResult.Removed('pl-unknownunknown12', 1))
        assert.equal(World.Placements.HoldingSlotOn(Agent.Self.Id).length, 0)
    })

    it('a result for another host\'s placement, or a placed one for an unknown placement, is refused', async () =>
    {
        const { World, Id } = await C.Pulled()
        const other = await World.ReportingHost(4, 'other')
        assert.equal(await C.CodeOf(other.Result(PlacementResult.Placed(Id, 1, C.ApiServer))), AgentExchangeRefusal.Mismatch)
        assert.equal(await C.CodeOf(other.Result(PlacementResult.Removed(Id, 1))), AgentExchangeRefusal.Mismatch)
        assert.equal(await C.CodeOf(other.Result(PlacementResult.Placed('pl-unknownunknown12', 1, C.ApiServer))), AgentExchangeRefusal.Mismatch)
        assert.equal(World.Placement(Id).state, PlacementState.Scheduled)
    })

    it('a code of a removed placement enrols nothing', async () =>
    {
        const { World, Agent, Id, Code, Label } = await C.Pulled()
        await World.Placements.BeginRemoval(Id)
        await Agent.Result(PlacementResult.Removed(Id, 2))
        assert.equal(await C.CodeOf(C.EnrolHive(World, Code, Label)), AgentExchangeRefusal.Mismatch)
        assert.equal(World.Directory.ListHives().length, 0)
    })

    it('a failed first placement deletes the credential it handed over', async () =>
    {
        const { World, Agent, Id } = await C.Pulled()
        await Agent.HandOver(Id, 1, C.Kubeconfig, new Date(World.Clock.Now().getTime() + 86_400_000))
        assert.ok(await World.Sealed.Get(ClusterCredentialHandover.ReferenceFor(Id)) !== undefined)
        await Agent.Result(PlacementResult.Failed(Id, 1, PlacementFailure.EnrolmentFailed))
        assert.equal(World.Placement(Id).state, PlacementState.Failed)
        assert.equal(await World.Sealed.Get(ClusterCredentialHandover.ReferenceFor(Id)), undefined)
    })

    it('an answered request leaves the host queue (it carried the hive code)', async () =>
    {
        const { World, Agent, Id } = await C.Pulled()
        assert.equal(World.Queue().filter(row => row.placementId === Id).length, 1)
        await Agent.Result(PlacementResult.Placed(Id, 1, C.ApiServer))
        assert.equal(World.Queue().filter(row => row.placementId === Id).length, 0)
    })

    it('lost answer: the same key re-presenting its redeemed placement code gets the same hive, no second record', async () =>
    {
        const { World, Code, Label, Id } = await C.Pulled()
        const hive = new FakeHiveAgent(World.Channel, World.Clock, World.TrustRoot.PublicKey)
        const first = await hive.Enrol(Code, HostWorld.TenantA, HiveLevel.Hosted, ConsoleAddress.RelayedHiveSubdomain(Label))
        const signer = EnvelopeSigner.SelfSigned(hive.Key, ParticipantRole.Hive, World.Clock)
        const body = HiveEnrolmentRequest.Create({ EnrolmentCode: Code, Tenant: HostWorld.TenantA, Level: HiveLevel.Hosted, PublicKey: hive.Key.PublicKey, EngineVersion: '0.1.0', ConsoleAddress: ConsoleAddress.RelayedHiveSubdomain(Label) })
        const reply = await World.Channel.Exchange(signer.Sign(MessageKind.HiveEnrolmentRequest, Participant.Platform, body))
        assert.ok(reply !== null)
        assert.equal(HiveEnrolmentResponse.Parse(reply.Body).HiveId, first.HiveId)
        assert.equal(World.Directory.ListHives().length, 1)
        assert.equal(World.Placement(Id).hiveId, first.HiveId)
        const other = new FakeHiveAgent(World.Channel, World.Clock, World.TrustRoot.PublicKey)
        assert.equal(await C.CodeOf(other.Enrol(Code, HostWorld.TenantA, HiveLevel.Hosted, ConsoleAddress.RelayedHiveSubdomain(Label))), AgentExchangeRefusal.Mismatch, 'another key: the placement links the first hive')
    })

    it('a placement code enrols only at its relayed hive subdomain, and a refusal does not spend it', async () =>
    {
        const { World, Code, Label, Id } = await C.Pulled()
        const hive = new FakeHiveAgent(World.Channel, World.Clock, World.TrustRoot.PublicKey)
        assert.equal(await C.CodeOf(hive.Enrol(Code, HostWorld.TenantA, HiveLevel.Hosted, ConsoleAddress.RelayedHiveSubdomain('acme-zzzz'))), AgentExchangeRefusal.Mismatch)
        assert.equal(await C.CodeOf(hive.Enrol(Code, HostWorld.TenantA, HiveLevel.Hosted, ConsoleAddress.OwnDomain(Label + '.acme.example'))), AgentExchangeRefusal.Mismatch)
        assert.equal(World.CodeRecord(r => r.placementId === Id)?.redeemedAt, undefined, 'not spent')
        assert.equal(World.Directory.ListHives().length, 0)
        await hive.Enrol(Code, HostWorld.TenantA, HiveLevel.Hosted, ConsoleAddress.RelayedHiveSubdomain(Label))
        assert.equal(World.Directory.ListHives().length, 1)
    })

    it('a placement already linked to another hive refuses before the code is spent', async () =>
    {
        const { World, Code, Label, Id } = await C.Pulled()
        await World.Placements.LinkHive(Id, 'hvzzzzzzzzzz')
        const hive = new FakeHiveAgent(World.Channel, World.Clock, World.TrustRoot.PublicKey)
        assert.equal(await C.CodeOf(hive.Enrol(Code, HostWorld.TenantA, HiveLevel.Hosted, ConsoleAddress.RelayedHiveSubdomain(Label))), AgentExchangeRefusal.Mismatch)
        assert.equal(World.CodeRecord(r => r.placementId === Id)?.redeemedAt, undefined, 'not spent')
        assert.equal(World.Directory.ListHives().length, 0, 'no hive written')
    })

    it('every request of a placement carries a strictly higher version: place, upgrade, removal', async () =>
    {
        const { World, Agent, Id } = await C.Pulled()
        await Agent.Result(PlacementResult.Placed(Id, 1, C.ApiServer))
        World.Releases.Offered = { Version: HostWorld.NewerVersion, ChartDigest: HostWorld.NewerChartDigest }
        await World.Scheduler.Tick()
        const [upgrade] = await Agent.PullPlacements()
        assert.equal(upgrade?.Body.Version, 2)
        await World.Placements.BeginRemoval(Id)
        await World.Scheduler.Tick()
        const [removal] = await Agent.PullPlacements()
        assert.equal(removal?.Body.Operation, PlacementOperation.Remove)
        assert.equal(removal?.Body.Version, 3)
    })

    it('a result must answer the current version: an old placed never marks an upgrade done, a future one is refused', async () =>
    {
        const { World, Agent, Id } = await C.Pulled()
        await Agent.Result(PlacementResult.Placed(Id, 1, C.ApiServer))
        World.Releases.Offered = { Version: HostWorld.NewerVersion, ChartDigest: HostWorld.NewerChartDigest }
        await World.Scheduler.Tick()
        await Agent.Result(PlacementResult.Placed(Id, 1, C.ApiServer))
        assert.equal(World.Placement(Id).placedEngineVersion, HostWorld.EngineVersion, 'the late answer to version 1 changes nothing')
        assert.equal(World.Queue().filter(row => row.placementId === Id).length, 1, 'and settles nothing: the upgrade stays queued')
        assert.equal(await C.CodeOf(Agent.Result(PlacementResult.Placed(Id, 3, C.ApiServer))), AgentExchangeRefusal.Mismatch)
        await Agent.Result(PlacementResult.Placed(Id, 2, C.ApiServer))
        assert.equal(World.Placement(Id).placedEngineVersion, HostWorld.NewerVersion)
        await World.Placements.BeginRemoval(Id)
        await Agent.Result(PlacementResult.Failed(Id, 2, PlacementFailure.EngineInstallFailed))
        assert.equal(World.Placement(Id).state, PlacementState.Removing, 'an old version\'s failure never undoes the removal')
    })
})
