import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AgentExchangeRefusal, ClusterKind, ConsoleAddress, EnvelopeSigner, HiveLevel, HostEnrolmentRequest, HostEnrolmentResponse, MessageKind, Participant, ParticipantRole } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeHiveAgent, FakeHostAgent } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { HiveLevel as CustomerHiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { EnrolmentAgentKind } from '../../enrolment/enrolment-code-record.js'
import { WorldRefusalError } from '../../hive-channel/tests/hive-channel-world.js'
import { HostRegistry } from '../host-registry.js'
import { HostWorld } from './host-world.js'

class HostEnrolmentCases
{
    /** The same key enrolling once more (the agent restarted before it kept its answer). */
    public static async EnrolAgain(world: HostWorld, agent: FakeHostAgent, code: string): Promise<HostEnrolmentResponse>
    {
        const signer = EnvelopeSigner.SelfSigned(agent.Key, ParticipantRole.Host, world.Clock)
        const body = HostEnrolmentRequest.Create({ EnrolmentCode: code, MachineName: HostWorld.Machine, PublicKey: agent.Key.PublicKey, ClusterKind: ClusterKind.Kind, AgentVersion: '0.1.0', MeshAddress: FakeHostAgent.DefaultMeshAddress })
        const reply = await world.Channel.Exchange(signer.Sign(MessageKind.HostEnrolmentRequest, Participant.Platform, body))
        assert.ok(reply !== null)
        return HostEnrolmentResponse.Parse(reply.Body)
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

describe('HostEnrolmentHandler', () =>
{
    const C = HostEnrolmentCases
    it('a host enrols with a host code and gets the sealing key', async () =>
    {
        const world = await HostWorld.Create()
        const agent = new FakeHostAgent(world.Channel, world.Clock, world.TrustRoot.PublicKey)
        const response = await agent.Enrol(await world.HostCode(), HostWorld.Machine)
        assert.match(response.HostId, HostRegistry.IdPattern)
        assert.ok(response.SealingKey.Equals(world.SealingKey.PublicKey))
        assert.ok(response.TrustRoot.Equals(world.TrustRoot.PublicKey))
        assert.equal(response.ChannelUrl, HostWorld.ChannelUrl)
        assert.equal(agent.Self.Role, ParticipantRole.Host)
        const host = world.Host(agent)
        assert.equal(host.machine, HostWorld.Machine)
        assert.equal(host.meshAddress, FakeHostAgent.DefaultMeshAddress)
        assert.equal(host.publicKey, agent.Key.PublicKey.ToJson())
        assert.equal(host.sealingKeyId, world.SealingKey.PublicKey.KeyId)
        assert.equal(host.enrolledBy, HostWorld.Operator)
        assert.ok(!JSON.stringify(host).includes('PRIVATE'))
    })

    it('a hive code cannot enrol a host, nor a host code a hive', async () =>
    {
        const world = await HostWorld.Create()
        const hiveCode = (await world.Codes.Issue({ ClientId: HostWorld.ClientId, TenantId: HostWorld.TenantA, Level: CustomerHiveLevel.Enrolled, AgentKind: EnrolmentAgentKind.Hive, IssuedBy: HostWorld.RequestedBy })).Code
        const host = new FakeHostAgent(world.Channel, world.Clock, world.TrustRoot.PublicKey)
        assert.equal(await C.CodeOf(host.Enrol(hiveCode, HostWorld.Machine)), AgentExchangeRefusal.Mismatch)
        const hive = new FakeHiveAgent(world.Channel, world.Clock, world.TrustRoot.PublicKey)
        assert.equal(await C.CodeOf(hive.Enrol(await world.HostCode(), HostWorld.TenantA, HiveLevel.Enrolled, ConsoleAddress.OwnDomain('console.acme.example'))), AgentExchangeRefusal.Mismatch)
        assert.equal(world.Hosts.List().length, 0)
        assert.equal(world.Directory.ListHives().length, 0)
    })

    it('a host code is not a customer reservation and redeems once', async () =>
    {
        const world = await HostWorld.Create()
        const code = await world.HostCode()
        assert.equal(world.Codes.OutstandingFor(HostWorld.ClientId, world.Clock.Now()), 0)
        await new FakeHostAgent(world.Channel, world.Clock).Enrol(code, HostWorld.Machine)
        assert.equal(await C.CodeOf(new FakeHostAgent(world.Channel, world.Clock).Enrol(code, 'other')), AgentExchangeRefusal.InvalidCode)
    })

    it('a key that already reported is key-registered; one that never reported gets the same host again (lost answer)', async () =>
    {
        const world = await HostWorld.Create()
        const agent = new FakeHostAgent(world.Channel, world.Clock)
        const first = await agent.Enrol(await world.HostCode(), HostWorld.Machine)
        const again = await C.EnrolAgain(world, agent, await world.HostCode())
        assert.equal(again.HostId, first.HostId)
        assert.equal(world.Hosts.List().length, 1)
        await agent.Report(HostWorld.Report())
        assert.equal(await C.CodeOf(C.EnrolAgain(world, agent, await world.HostCode())), AgentExchangeRefusal.KeyRegistered)
    })

    it('a Pull is dispatched by issuer role: a host pulls placements, a hive Pull is not the placement handler one', async () =>
    {
        const world = await HostWorld.Create()
        const host = await world.ReportingHost()
        assert.deepEqual(await host.PullPlacements(), [])
        const code = (await world.Codes.Issue({ ClientId: HostWorld.ClientId, TenantId: HostWorld.TenantA, Level: CustomerHiveLevel.Enrolled, AgentKind: EnrolmentAgentKind.Hive, IssuedBy: HostWorld.RequestedBy })).Code
        const hive = new FakeHiveAgent(world.Channel, world.Clock, world.TrustRoot.PublicKey)
        await hive.Enrol(code, HostWorld.TenantA, HiveLevel.Enrolled, ConsoleAddress.OwnDomain('console.acme.example'))
        assert.equal(await C.CodeOf(hive.PullIntents()), AgentExchangeRefusal.UnsupportedKind)
    })

    it('without the sealing key no host kind is taken, and a warning says so', async () =>
    {
        const world = await HostWorld.Create(false)
        assert.equal(await C.CodeOf(new FakeHostAgent(world.Channel, world.Clock).Enrol(await world.HostCode(), HostWorld.Machine)), AgentExchangeRefusal.UnsupportedKind)
        assert.equal(world.Logs.length, 1)
        assert.equal(world.HostChannel.Scheduler, undefined)
    })
})
