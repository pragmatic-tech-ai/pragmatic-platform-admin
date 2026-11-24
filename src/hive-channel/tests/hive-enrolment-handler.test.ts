import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HiveLevel as CustomerHiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import {
    AgentExchangeRefusal, ConsoleAddress, EnrolmentHandshake, EnvelopeSigner, HiveEnrolmentRequest, HiveLevel, InMemoryNonceLedger, MessageKind,
    HiveReport, Participant, ParticipantRole, SignedEnvelope, SigningKeyPair,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeAgentChannel, FakeHiveAgent, FakePlatform } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { EnrolmentAgentKind } from '../../enrolment/enrolment-code-record.js'
import type { PlatformHiveRecord } from '../../platform-records.js'
import { HiveIdAllocator } from '../hive-id-allocator.js'
import { HiveChannelWorld, WorldRefusalError } from './hive-channel-world.js'

class EnrolmentCases
{
    public static readonly Version = '0.1.7'
    public static readonly ConsoleHost = 'console.acme.example'

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

    /** A self-signed enrolment request from `key`, as a hive agent sends it. */
    public static Request(world: HiveChannelWorld, key: SigningKeyPair, code: string, tenant: string, level: string): string
    {
        const signer = EnvelopeSigner.SelfSigned(key, ParticipantRole.Hive, world.Clock)
        const json = HiveEnrolmentRequest.Create({ EnrolmentCode: code, Tenant: tenant, Level: HiveLevel.Enrolled, PublicKey: key.PublicKey, EngineVersion: EnrolmentCases.Version, ConsoleAddress: ConsoleAddress.OwnDomain(EnrolmentCases.ConsoleHost) }).ToJson()
        return signer.Sign(MessageKind.HiveEnrolmentRequest, Participant.Platform, { ToJson: () => ({ ...json, Level: level }) }).Encode()
    }
}

describe('HiveEnrolmentHandler', () =>
{
    it('a valid request creates one hive record with the public half only and answers a response the FakeHiveAgent accepts', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const agent = new FakeHiveAgent(world.Channel, world.Clock, world.TrustRoot.PublicKey)
        const response = await agent.Enrol(await world.IssueCode(), HiveChannelWorld.TenantA, HiveLevel.Enrolled, ConsoleAddress.OwnDomain(EnrolmentCases.ConsoleHost))
        assert.match(response.HiveId, HiveIdAllocator.Pattern)
        assert.equal(response.Tenant, HiveChannelWorld.TenantA)
        assert.equal(agent.Self.Id, response.HiveId)
        const hives = world.Directory.ListHives() as readonly PlatformHiveRecord[]
        assert.equal(hives.length, 1)
        const hive = hives[0] as PlatformHiveRecord
        assert.equal(hive.id, response.HiveId)
        assert.equal(hive.level, CustomerHiveLevel.Enrolled)
        assert.equal(hive.publicKey, agent.Key.PublicKey.ToJson())
        assert.equal(hive.keyId, agent.Key.KeyId)
        assert.equal(hive.engineVersion, FakeHiveAgent.DefaultVersion)
        assert.deepEqual(hive.consoleAddress, { Option: 'own-domain', Host: EnrolmentCases.ConsoleHost, IngressAddress: null })
        assert.equal(hive.enrolledBy, HiveChannelWorld.IssuedBy)
        assert.equal(hive.agentTokenRef, undefined)
        const stored = JSON.stringify(hive)
        assert.ok(!stored.includes('PRIVATE'), 'no private key material in the record')
    })

    it('Delegated enrols at Delegated', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const agent = new FakeHiveAgent(world.Channel, world.Clock)
        const response = await agent.Enrol(await world.IssueCode(HiveChannelWorld.TenantA, CustomerHiveLevel.Delegated), HiveChannelWorld.TenantA, HiveLevel.Delegated)
        assert.equal(response.Level, HiveLevel.Delegated)
        assert.equal((world.Directory.GetHive(response.HiveId) as PlatformHiveRecord).level, CustomerHiveLevel.Delegated)
    })

    it('a code for another tenant, level or agent kind is refused mismatch', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const agent = new FakeHiveAgent(world.Channel, world.Clock)
        const otherTenant = await world.IssueCode(HiveChannelWorld.TenantB)
        assert.equal(await EnrolmentCases.CodeOf(agent.Enrol(otherTenant, HiveChannelWorld.TenantA, HiveLevel.Enrolled)), AgentExchangeRefusal.Mismatch)
        const otherLevel = await world.IssueCode(HiveChannelWorld.TenantA, CustomerHiveLevel.Delegated)
        assert.equal(await EnrolmentCases.CodeOf(agent.Enrol(otherLevel, HiveChannelWorld.TenantA, HiveLevel.Enrolled)), AgentExchangeRefusal.Mismatch)
        const hostCode = await world.IssueCode(HiveChannelWorld.TenantA, CustomerHiveLevel.Enrolled, EnrolmentAgentKind.Host)
        assert.equal(await EnrolmentCases.CodeOf(agent.Enrol(hostCode, HiveChannelWorld.TenantA, HiveLevel.Enrolled)), AgentExchangeRefusal.Mismatch)
        assert.equal(world.Directory.ListHives().length, 0)
    })

    it('a used or expired code is refused', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const code = await world.IssueCode()
        await new FakeHiveAgent(world.Channel, world.Clock).Enrol(code, HiveChannelWorld.TenantA, HiveLevel.Enrolled)
        assert.equal(await EnrolmentCases.CodeOf(new FakeHiveAgent(world.Channel, world.Clock).Enrol(code, HiveChannelWorld.TenantA, HiveLevel.Enrolled)), AgentExchangeRefusal.InvalidCode)
        const expiring = await world.IssueCode()
        world.Clock.Advance(31 * 60 * 1000)
        assert.equal(await EnrolmentCases.CodeOf(new FakeHiveAgent(world.Channel, world.Clock).Enrol(expiring, HiveChannelWorld.TenantA, HiveLevel.Enrolled)), AgentExchangeRefusal.InvalidCode)
        assert.equal(await EnrolmentCases.CodeOf(new FakeHiveAgent(world.Channel, world.Clock).Enrol('pe1-AAAAAAAAAAAAAAAAAAAAAAAAAA', HiveChannelWorld.TenantA, HiveLevel.Enrolled)), AgentExchangeRefusal.InvalidCode)
        assert.equal(world.Directory.ListHives().length, 1)
    })

    it('a second enrolment with an already-registered key is refused key-registered', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const agent = new FakeHiveAgent(world.Channel, world.Clock)
        const first = await agent.Enrol(await world.IssueCode(), HiveChannelWorld.TenantA, HiveLevel.Enrolled)
        await world.Observations.RecordReport(first.HiveId, HiveReport.Create({ EngineVersion: EnrolmentCases.Version, Components: [], Environments: [], Intents: [] }))
        const again = await world.IssueCode()
        const redeemedBefore = world.Codes.Redeemed
        assert.equal(await EnrolmentCases.CodeOf(world.Channel.SendText(EnrolmentCases.Request(world, agent.Key, again, HiveChannelWorld.TenantA, HiveLevel.Enrolled))), AgentExchangeRefusal.KeyRegistered)
        assert.equal(world.Codes.Redeemed, redeemedBefore, 'the code is not touched')
        const otherTenant = await world.IssueCode(HiveChannelWorld.TenantB)
        assert.equal(await EnrolmentCases.CodeOf(world.Channel.SendText(EnrolmentCases.Request(world, agent.Key, otherTenant, HiveChannelWorld.TenantB, HiveLevel.Enrolled))), AgentExchangeRefusal.KeyRegistered)
        assert.equal(world.Directory.ListHives().length, 1)
    })

    it('an agent that restarted before keeping the answer gets the same hive for a new code, never a second record', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const key = SigningKeyPair.Generate()
        const lost = await world.Channel.SendText(EnrolmentCases.Request(world, key, await world.IssueCode(), HiveChannelWorld.TenantA, HiveLevel.Enrolled))
        assert.ok(lost !== null)
        const [first] = world.Directory.ListHives()
        const reply = await world.Channel.SendText(EnrolmentCases.Request(world, key, await world.IssueCode(), HiveChannelWorld.TenantA, HiveLevel.Enrolled))
        assert.ok(reply !== null)
        assert.equal(world.Directory.ListHives().length, 1)
        const verified = await new EnrolmentHandshake({ Clock: world.Clock, Nonces: new InMemoryNonceLedger(world.Clock), PinnedTrustRoot: world.TrustRoot.PublicKey })
            .AcceptHive(reply, SignedEnvelope.Decode(world.Channel.Sent.at(-1) as string))
        assert.equal(verified.Body.HiveId, first?.id)
        assert.equal(world.Codes.Redeemed, 2, 'the new code is used')
    })

    it('two concurrent enrolments of one key record one hive', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const key = SigningKeyPair.Generate()
        const a = EnrolmentCases.Request(world, key, await world.IssueCode(), HiveChannelWorld.TenantA, HiveLevel.Enrolled)
        const b = EnrolmentCases.Request(world, key, await world.IssueCode(), HiveChannelWorld.TenantA, HiveLevel.Enrolled)
        await Promise.allSettled([world.Channel.SendText(a), world.Channel.SendText(b)])
        assert.equal(world.Directory.ListHives().length, 1)
    })

    it('Standalone is never enrolled', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const code = await world.IssueCode(HiveChannelWorld.TenantA, CustomerHiveLevel.Standalone)
        assert.equal(await EnrolmentCases.CodeOf(world.Channel.SendText(EnrolmentCases.Request(world, SigningKeyPair.Generate(), code, HiveChannelWorld.TenantA, HiveLevel.Standalone))), AgentExchangeRefusal.Malformed)
        assert.equal(world.Codes.Redeemed, 0)
        assert.equal(world.Directory.ListHives().length, 0)
    })

    it('cross-check: the shared FakePlatform and this handler produce responses the same EnrolmentHandshake accepts', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const fake = new FakePlatform(world.Clock)
        for (const [channel, code, root] of [
            [world.Channel, await world.IssueCode(), world.TrustRoot.PublicKey],
            [new FakeAgentChannel(fake), fake.IssueHiveCode(HiveChannelWorld.TenantA, HiveLevel.Enrolled), fake.TrustRoot],
        ] as const)
        {
            const agent = new FakeHiveAgent(channel, world.Clock, root)
            const response = await agent.Enrol(code, HiveChannelWorld.TenantA, HiveLevel.Enrolled)
            assert.equal(response.Tenant, HiveChannelWorld.TenantA)
            assert.ok(agent.Enrolled)
        }
    })
})
