import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    AgentExchangeRefusal, ComponentReport, ComponentState, EnvelopeSigner, HiveEnrolmentRequest, HiveLevel, HiveReport, MessageKind, Participant, ParticipantRole,
    ConsoleAddress, SignedEnvelope, SigningKeyPair,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeHiveAgent } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { HiveChannelWorld, WorldRefusalError } from './hive-channel-world.js'

class ExchangeCases
{
    public static readonly Version = '0.1.7'

    public static Report(): HiveReport
    {
        return HiveReport.Create({ EngineVersion: ExchangeCases.Version, Components: [new ComponentReport('pragmatic-hive-agent', ComponentState.Ready, ExchangeCases.Version)], Environments: [], Intents: [] })
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

describe('PlatformAgentExchange', () =>
{
    it('answers are signed by the trust root', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const agent = new FakeHiveAgent(world.Channel, world.Clock, world.TrustRoot.PublicKey)
        const response = await agent.Enrol(await world.IssueCode(), HiveChannelWorld.TenantA, HiveLevel.Enrolled)
        assert.ok(response.TrustRoot.Equals(world.TrustRoot.PublicKey))
        assert.equal(response.ChannelUrl, HiveChannelWorld.ChannelUrl)
    })

    it('a replayed enrolment request is refused by the nonce ledger before the code is touched', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const agent = new FakeHiveAgent(world.Channel, world.Clock)
        await agent.Enrol(await world.IssueCode(), HiveChannelWorld.TenantA, HiveLevel.Enrolled)
        assert.equal(world.Codes.Redeemed, 1)
        const captured = world.Channel.Sent[0] as string
        assert.equal(await ExchangeCases.CodeOf(world.Channel.SendText(captured)), AgentExchangeRefusal.Replayed)
        assert.equal(world.Codes.Redeemed, 1)
        assert.equal(world.Directory.ListHives().length, 1)
    })

    it('an envelope signed by an unknown key is refused with a code', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const stranger = new EnvelopeSigner(SigningKeyPair.Generate(), Participant.Hive('hvaaaaaaaaaa'), world.Clock)
        const envelope = stranger.Sign(MessageKind.HiveReport, Participant.Platform, ExchangeCases.Report())
        assert.equal(await ExchangeCases.CodeOf(world.Channel.Exchange(envelope)), AgentExchangeRefusal.NotVerified)
    })

    it('a kind not signable by its issuer is refused', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const agent = new FakeHiveAgent(world.Channel, world.Clock)
        await agent.Enrol(await world.IssueCode(), HiveChannelWorld.TenantA, HiveLevel.Enrolled)
        const report = new EnvelopeSigner(agent.Key, agent.Self, world.Clock).Sign(MessageKind.HiveReport, Participant.Platform, ExchangeCases.Report())
        const forged = JSON.parse(report.Encode()) as Record<string, unknown>
        forged.Issuer = { Role: ParticipantRole.Host, Id: agent.Self.Id }
        assert.equal(await ExchangeCases.CodeOf(world.Channel.SendText(JSON.stringify(forged))), AgentExchangeRefusal.NotVerified)
        const unsupported = { ...JSON.parse(report.Encode()) as Record<string, unknown>, Kind: MessageKind.PullBatch }
        assert.equal(await ExchangeCases.CodeOf(world.Channel.SendText(JSON.stringify(unsupported))), AgentExchangeRefusal.UnsupportedKind)
    })

    it('malformed bodies burn no nonce', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const key = SigningKeyPair.Generate()
        const signer = EnvelopeSigner.SelfSigned(key, ParticipantRole.Hive, world.Clock)
        const body = HiveEnrolmentRequest.Create({ EnrolmentCode: await world.IssueCode(), Tenant: HiveChannelWorld.TenantA, Level: HiveLevel.Enrolled, PublicKey: key.PublicKey, EngineVersion: ExchangeCases.Version, ConsoleAddress: ConsoleAddress.OwnDomain('console.acme.example') })
        const good = signer.Sign(MessageKind.HiveEnrolmentRequest, Participant.Platform, body)
        const json = JSON.parse(good.Encode()) as Record<string, unknown>
        const badBody = { ...json, Body: { ...(json.Body as Record<string, unknown>), Extra: true } }
        assert.equal(await ExchangeCases.CodeOf(world.Channel.SendText(JSON.stringify(badBody))), AgentExchangeRefusal.Malformed)
        assert.equal(await ExchangeCases.CodeOf(world.Channel.SendText('{"not":"an envelope"}')), AgentExchangeRefusal.Malformed)
        assert.equal((world.Nonces as unknown as { Size: number }).Size, 0)
        assert.equal(world.Codes.Redeemed, 0)
        // The same nonce still enrols once the body is right (it was never claimed).
        const reply = await world.Channel.SendText(good.Encode())
        assert.ok(reply instanceof SignedEnvelope)
    })
})
