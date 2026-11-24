import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AgentExchangeRefusal, ApiServerAddress, ClusterCredentialHandover, MessageKind, PlacementResult, SealingKeyPair } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeHostAgent } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { WorldRefusalError } from '../../hive-channel/tests/hive-channel-world.js'
import { HandedOverKubeconfig } from '../handed-over-kubeconfig.js'
import { HostKubeconfigs, HostWorld } from './host-world.js'

class HandoverCases
{
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

    public static async Stored(world: HostWorld, placementId: string): Promise<Record<string, unknown> | undefined>
    {
        const bytes = await world.Sealed.Get(ClusterCredentialHandover.ReferenceFor(placementId))
        return bytes === undefined ? undefined : JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
    }

    public static TokenOf(kubeconfig: Record<string, unknown> | undefined): string | undefined
    {
        return (kubeconfig?.users as Array<{ user: { token: string } }> | undefined)?.[0]?.user.token
    }
}

describe('CredentialHandoverHandler', () =>
{
    const C = HandoverCases
    it('a handover opens into clusters/<placement>, rebuilt by the platform, and the blob is not stored', async () =>
    {
        const { World, Agent, PlacementId } = await C.Scheduled()
        await Agent.HandOver(PlacementId, 1, HostKubeconfigs.Valid(), C.Expiry(World))
        const stored = await C.Stored(World, PlacementId)
        const cluster = (stored?.clusters as Array<{ cluster: Record<string, string> }>)[0]?.cluster
        assert.deepEqual(cluster, { server: 'https://' + FakeHostAgent.DefaultMeshAddress + ':' + String(HostKubeconfigs.Port), 'certificate-authority-data': HostKubeconfigs.Ca })
        assert.equal(C.TokenOf(stored), HostKubeconfigs.Token)
        assert.equal(stored?.['current-context'], 'pragmatic-hosted', 'the platform\'s own names, not the agent\'s')
        const placement = World.Placement(PlacementId)
        assert.equal(placement.credentialRotation, 1)
        assert.equal(placement.apiPort, HostKubeconfigs.Port)
        assert.equal(placement.credentialExpiresAt, C.Expiry(World).toISOString())
        const sent = World.Channel.Sent.at(-1) as string
        const blob = (JSON.parse(sent) as { Body: { Sealed: { Ciphertext: string } } }).Body.Sealed.Ciphertext
        assert.ok(!JSON.stringify([...World.Placements.List(), ...World.Hosts.List(), ...World.Queue()]).includes(blob), 'the ciphertext is nowhere in the records')
    })

    it('a lower or equal rotation number is refused and never overwrites the newer credential', async () =>
    {
        const { World, Agent, PlacementId } = await C.Scheduled()
        await Agent.HandOver(PlacementId, 2, HostKubeconfigs.Valid(HostKubeconfigs.Port, 'two'), C.Expiry(World))
        assert.equal(await C.CodeOf(Agent.HandOver(PlacementId, 2, HostKubeconfigs.Valid(), C.Expiry(World))), AgentExchangeRefusal.Replayed)
        assert.equal(await C.CodeOf(Agent.HandOver(PlacementId, 1, HostKubeconfigs.Valid(), C.Expiry(World))), AgentExchangeRefusal.Replayed)
        assert.equal(C.TokenOf(await C.Stored(World, PlacementId)), HostKubeconfigs.Token + 'two')
        await Agent.HandOver(PlacementId, 3, HostKubeconfigs.Valid(HostKubeconfigs.Port, 'three'), C.Expiry(World))
        assert.equal(C.TokenOf(await C.Stored(World, PlacementId)), HostKubeconfigs.Token + 'three', 'a higher rotation replaces it')
    })

    it('a handover for another host\'s placement is refused', async () =>
    {
        const { World, PlacementId } = await C.Scheduled()
        const other = await World.ReportingHost(4, 'other-machine')
        assert.equal(await C.CodeOf(other.HandOver(PlacementId, 1, HostKubeconfigs.Valid(), C.Expiry(World))), AgentExchangeRefusal.Mismatch)
        assert.equal(await C.CodeOf(other.HandOver('pl-unknown', 1, HostKubeconfigs.Valid(), C.Expiry(World))), AgentExchangeRefusal.Mismatch)
        assert.equal(await C.Stored(World, PlacementId), undefined)
    })

    it('a blob moved from another message (another rotation or host) does not open', async () =>
    {
        const { World, Agent, PlacementId } = await C.Scheduled()
        const original = ClusterCredentialHandover.Create({ Host: Agent.Self, PlacementId, Rotation: 1, ExpiresAt: C.Expiry(World), Credential: HostKubeconfigs.Valid(), SealingKey: Agent.SealingKey })
        const moved = ClusterCredentialHandover.Parse({ ...original.ToJson(), Rotation: 5 })
        assert.equal(await C.CodeOf(Agent.Send(MessageKind.ClusterCredentialHandover, moved)), AgentExchangeRefusal.NotVerified)
        const other = await World.ReportingHost(4, 'other-machine')
        const foreign = ClusterCredentialHandover.Create({ Host: other.Self, PlacementId, Rotation: 1, ExpiresAt: C.Expiry(World), Credential: HostKubeconfigs.Valid(), SealingKey: Agent.SealingKey })
        assert.equal(await C.CodeOf(Agent.Send(MessageKind.ClusterCredentialHandover, foreign)), AgentExchangeRefusal.NotVerified)
        assert.equal(await C.Stored(World, PlacementId), undefined)
    })

    it('a handover sealed to another key than the one platform sealing key is refused not-verified (rotation means re-enrolment)', async () =>
    {
        const { World, Agent, PlacementId } = await C.Scheduled()
        const handover = ClusterCredentialHandover.Create({ Host: Agent.Self, PlacementId, Rotation: 1, ExpiresAt: C.Expiry(World), Credential: HostKubeconfigs.Valid(), SealingKey: SealingKeyPair.Generate().PublicKey })
        assert.equal(await C.CodeOf(Agent.Send(MessageKind.ClusterCredentialHandover, handover)), AgentExchangeRefusal.NotVerified)
    })

    it('a placement being removed takes no credential', async () =>
    {
        const { World, Agent, PlacementId } = await C.Scheduled()
        await World.Placements.BeginRemoval(PlacementId)
        assert.equal(await C.CodeOf(Agent.HandOver(PlacementId, 1, HostKubeconfigs.Valid(), C.Expiry(World))), AgentExchangeRefusal.Mismatch)
    })

    it('refuses an exec user, another server, an insecure cluster or any extra member (malformed), and a port other than the placement\'s', async () =>
    {
        const { World, Agent, PlacementId } = await C.Scheduled()
        const broken: Array<(k: Record<string, unknown>) => void> = [
            k => { (k.users as Array<Record<string, unknown>>)[0] = { name: 'pragmatic-platform', user: { exec: { command: 'sh' } } } },
            k => { ((k.users as Array<{ user: Record<string, unknown> }>)[0] as { user: Record<string, unknown> }).user['client-key'] = '/etc/key' },
            k => { ((k.clusters as Array<{ cluster: Record<string, unknown> }>)[0] as { cluster: Record<string, unknown> }).cluster.server = 'https://evil.example:16444' },
            k => { ((k.clusters as Array<{ cluster: Record<string, unknown> }>)[0] as { cluster: Record<string, unknown> }).cluster.server = 'http://' + FakeHostAgent.DefaultMeshAddress + ':16444' },
            k => { ((k.clusters as Array<{ cluster: Record<string, unknown> }>)[0] as { cluster: Record<string, unknown> }).cluster['insecure-skip-tls-verify'] = true },
            k => { ((k.clusters as Array<{ cluster: Record<string, unknown> }>)[0] as { cluster: Record<string, unknown> }).cluster['proxy-url'] = 'http://proxy' },
            k => { k.preferences = {} },
            k => { (k.users as unknown[]).push({ name: 'second', user: { token: 'x' } }) },
        ]
        let rotation = 1
        for (const breakIt of broken)
        {
            const value = HostKubeconfigs.Object()
            breakIt(value)
            assert.equal(await C.CodeOf(Agent.HandOver(PlacementId, rotation++, HostKubeconfigs.Of(value), C.Expiry(World))), AgentExchangeRefusal.Malformed)
        }
        assert.equal(await C.CodeOf(Agent.HandOver(PlacementId, rotation++, Buffer.from('apiVersion: v1\n'), C.Expiry(World))), AgentExchangeRefusal.Malformed, 'not JSON')
        assert.equal(await C.Stored(World, PlacementId), undefined)
        await Agent.HandOver(PlacementId, rotation++, HostKubeconfigs.Valid(), C.Expiry(World))
        assert.equal(await C.CodeOf(Agent.HandOver(PlacementId, rotation++, HostKubeconfigs.Valid(HostKubeconfigs.Port + 1), C.Expiry(World))), AgentExchangeRefusal.Mismatch, 'the placement\'s port is fixed')
    })

    it('a placed result must name the host\'s mesh address and the placement\'s port', async () =>
    {
        const { World, Agent, PlacementId } = await C.Scheduled()
        await Agent.HandOver(PlacementId, 1, HostKubeconfigs.Valid(), C.Expiry(World))
        assert.equal(await C.CodeOf(Agent.Result(PlacementResult.Placed(PlacementId, 1, new ApiServerAddress('other.mesh.test', HostKubeconfigs.Port)))), AgentExchangeRefusal.Mismatch)
        assert.equal(await C.CodeOf(Agent.Result(PlacementResult.Placed(PlacementId, 1, new ApiServerAddress(FakeHostAgent.DefaultMeshAddress, HostKubeconfigs.Port + 1)))), AgentExchangeRefusal.Mismatch)
        await Agent.Result(PlacementResult.Placed(PlacementId, 1, new ApiServerAddress(FakeHostAgent.DefaultMeshAddress, HostKubeconfigs.Port)))
        assert.equal(World.Placement(PlacementId).state, 'placed')
    })

    it('the parsed credential never prints its token', () =>
    {
        const parsed = HandedOverKubeconfig.Parse(HostKubeconfigs.Valid(), FakeHostAgent.DefaultMeshAddress)
        assert.ok(!JSON.stringify(parsed).includes(HostKubeconfigs.Token))
    })
})
