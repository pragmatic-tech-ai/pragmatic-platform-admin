import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AgentExchangeRefusal, ClusterCredentialHandover, MessageKind, SealedBlob } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { FakeHostAgent } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { WorldRefusalError } from '../../hive-channel/tests/hive-channel-world.js'
import { HostWorld } from './host-world.js'

class HandoverCases
{
    public static readonly Kubeconfig = Buffer.from('apiVersion: v1\nkind: Config\nclusters: []\n')
    public static readonly Rotated = Buffer.from('apiVersion: v1\nkind: Config\nclusters: [] # rotated\n')

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

    /** A world with one fresh host and one placement scheduled on it. */
    public static async Scheduled(): Promise<{ World: HostWorld; Agent: FakeHostAgent; PlacementId: string }>
    {
        const world = await HostWorld.Create()
        const agent = await world.ReportingHost()
        const placement = await world.Request()
        await world.Scheduler.Tick()
        return { World: world, Agent: agent, PlacementId: placement.id }
    }

    public static Expiry(world: HostWorld): Date
    {
        return new Date(world.Clock.Now().getTime() + 7 * 24 * 60 * 60 * 1000)
    }
}

describe('CredentialHandoverHandler', () =>
{
    const C = HandoverCases
    it('a handover opens into clusters/<placement> and the blob is not stored', async () =>
    {
        const { World, Agent, PlacementId } = await C.Scheduled()
        await Agent.HandOver(PlacementId, 1, C.Kubeconfig, C.Expiry(World))
        const ref = ClusterCredentialHandover.ReferenceFor(PlacementId)
        assert.deepEqual(await World.Sealed.Get(ref), C.Kubeconfig)
        const placement = World.Placement(PlacementId)
        assert.equal(placement.credentialRotation, 1)
        assert.equal(placement.credentialExpiresAt, C.Expiry(World).toISOString())
        const sent = World.Channel.Sent.at(-1) as string
        const blob = (JSON.parse(sent) as { Body: { Sealed: { Ciphertext: string } } }).Body.Sealed.Ciphertext
        assert.ok(!JSON.stringify([...World.Placements.List(), ...World.Hosts.List(), ...World.Queue()]).includes(blob), 'the ciphertext is nowhere in the records')
    })

    it('a lower or equal rotation number is refused and never overwrites the newer credential', async () =>
    {
        const { World, Agent, PlacementId } = await C.Scheduled()
        await Agent.HandOver(PlacementId, 2, C.Rotated, C.Expiry(World))
        assert.equal(await C.CodeOf(Agent.HandOver(PlacementId, 2, C.Kubeconfig, C.Expiry(World))), AgentExchangeRefusal.Replayed)
        assert.equal(await C.CodeOf(Agent.HandOver(PlacementId, 1, C.Kubeconfig, C.Expiry(World))), AgentExchangeRefusal.Replayed)
        assert.deepEqual(await World.Sealed.Get(ClusterCredentialHandover.ReferenceFor(PlacementId)), C.Rotated)
        await Agent.HandOver(PlacementId, 3, C.Kubeconfig, C.Expiry(World))
        assert.deepEqual(await World.Sealed.Get(ClusterCredentialHandover.ReferenceFor(PlacementId)), C.Kubeconfig, 'a higher rotation replaces it')
    })

    it('a handover for another host\'s placement is refused', async () =>
    {
        const { World, PlacementId } = await C.Scheduled()
        const other = await World.ReportingHost(4, 'other-machine')
        assert.equal(await C.CodeOf(other.HandOver(PlacementId, 1, C.Kubeconfig, C.Expiry(World))), AgentExchangeRefusal.Mismatch)
        assert.equal(await C.CodeOf(other.HandOver('pl-unknown', 1, C.Kubeconfig, C.Expiry(World))), AgentExchangeRefusal.Mismatch)
        assert.equal(await World.Sealed.Get(ClusterCredentialHandover.ReferenceFor(PlacementId)), undefined)
    })

    it('a blob moved from another message (another rotation, placement or host) does not open', async () =>
    {
        const { World, Agent, PlacementId } = await C.Scheduled()
        const original = ClusterCredentialHandover.Create({ Host: Agent.Self, PlacementId, Rotation: 1, ExpiresAt: C.Expiry(World), Credential: C.Kubeconfig, SealingKey: Agent.SealingKey })
        const moved = ClusterCredentialHandover.Parse({ ...original.ToJson(), Rotation: 5 })
        assert.equal(await C.CodeOf(Agent.Send(MessageKind.ClusterCredentialHandover, moved)), AgentExchangeRefusal.NotVerified)
        const other = await World.ReportingHost(4, 'other-machine')
        const foreign = ClusterCredentialHandover.Create({ Host: other.Self, PlacementId, Rotation: 1, ExpiresAt: C.Expiry(World), Credential: C.Kubeconfig, SealingKey: Agent.SealingKey })
        assert.equal(await C.CodeOf(Agent.Send(MessageKind.ClusterCredentialHandover, foreign)), AgentExchangeRefusal.NotVerified)
        assert.equal(await World.Sealed.Get(ClusterCredentialHandover.ReferenceFor(PlacementId)), undefined)
        assert.ok(SealedBlob.MaxPlaintextBytes <= 65536)
    })

    it('a placement being removed takes no credential', async () =>
    {
        const { World, Agent, PlacementId } = await C.Scheduled()
        await World.Placements.BeginRemoval(PlacementId)
        assert.equal(await C.CodeOf(Agent.HandOver(PlacementId, 1, C.Kubeconfig, C.Expiry(World))), AgentExchangeRefusal.Mismatch)
    })
})
