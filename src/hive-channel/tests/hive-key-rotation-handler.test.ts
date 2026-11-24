import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    AgentExchangeRefusal, EnvelopeSigner, HiveKeyRotation, HiveKeyRotationAck, HiveLevel, HiveReport, MessageKind, Participant, SigningKeyPair,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeHiveAgent } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import type { PlatformHiveRecord } from '../../platform-records.js'
import { HiveKeyChangedError } from '../../platform-directory.js'
import { PreviousKeyGrace } from '../previous-key-grace.js'
import { HiveChannelWorld, WorldRefusalError } from './hive-channel-world.js'

class RotationCases
{
    public static async Hive(world: HiveChannelWorld): Promise<FakeHiveAgent>
    {
        const agent = new FakeHiveAgent(world.Channel, world.Clock, world.TrustRoot.PublicKey)
        await agent.Enrol(await world.IssueCode(), HiveChannelWorld.TenantA, HiveLevel.Enrolled)
        return agent
    }

    public static Report(): HiveReport
    {
        return HiveReport.Create({ EngineVersion: '0.1.0', Components: [], Environments: [], Intents: [] })
    }

    public static Refused(code: AgentExchangeRefusal): (error: unknown) => boolean
    {
        return (error: unknown) => error instanceof WorldRefusalError && error.Code === code
    }
}

describe('HiveKeyRotationHandler', () =>
{
    it('a hive key rotation switches the key directory atomically and the old key is refused', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await RotationCases.Hive(world)
        const old = hive.Key
        const ack = await hive.RotateKey()
        const record = world.Directory.GetHive(hive.Self.Id) as PlatformHiveRecord
        assert.equal(ack.KeyId, hive.Key.KeyId)
        assert.equal(record.keyId, hive.Key.KeyId)
        assert.equal(record.publicKey, hive.Key.PublicKey.ToJson())
        assert.ok(record.keyRotatedAt !== undefined)
        await hive.Report(RotationCases.Report())
        const stale = new EnvelopeSigner(old, hive.Self, world.Clock).Sign(MessageKind.HiveReport, Participant.Platform, RotationCases.Report())
        await assert.rejects(world.Channel.Exchange(stale), RotationCases.Refused(AgentExchangeRefusal.NotVerified))
    })

    it('a rotation naming another hive, another previous key or an unproven key is refused and the key stays', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await RotationCases.Hive(world)
        const other = await RotationCases.Hive(world)
        const keyId = hive.Key.KeyId
        const next = SigningKeyPair.Generate()
        const forged = HiveKeyRotation.Parse({ ...HiveKeyRotation.Create(hive.Self.Id, keyId, next).ToJson(), NewPublicKey: SigningKeyPair.Generate().PublicKey.ToJson() })
        for (const body of [HiveKeyRotation.Create(other.Self.Id, keyId, next), HiveKeyRotation.Create(hive.Self.Id, other.Key.KeyId, next), forged])
        {
            await assert.rejects(hive.Send(MessageKind.HiveKeyRotation, body), RotationCases.Refused(AgentExchangeRefusal.NotVerified))
        }
        assert.equal((world.Directory.GetHive(hive.Self.Id) as PlatformHiveRecord).keyId, keyId)
    })

    it('a new key registered to another hive is refused key-registered', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await RotationCases.Hive(world)
        const other = await RotationCases.Hive(world)
        // The other hive's key proving itself as this hive's new key: it holds the private half, yet it is in use.
        const body = HiveKeyRotation.Create(hive.Self.Id, hive.Key.KeyId, other.Key)
        await assert.rejects(hive.Send(MessageKind.HiveKeyRotation, body), RotationCases.Refused(AgentExchangeRefusal.KeyRegistered))
    })

    it('a left hive cannot rotate', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await RotationCases.Hive(world)
        await world.Directory.MarkHiveLeft(hive.Self.Id)
        await assert.rejects(hive.RotateKey(), RotationCases.Refused(AgentExchangeRefusal.HiveGone))
    })

    it('lost ack: the hive asks again under its previous key and is acknowledged again, until it uses the new key', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await RotationCases.Hive(world)
        const old = hive.Key
        const next = SigningKeyPair.Generate()
        const rotation = HiveKeyRotation.Create(hive.Self.Id, old.KeyId, next)
        const signer = new EnvelopeSigner(old, hive.Self, world.Clock)
        assert.ok(await world.Channel.Exchange(signer.Sign(MessageKind.HiveKeyRotation, Participant.Platform, rotation)) !== null)
        // The acknowledgement was lost: the agent still holds the old key and asks again, signed by it.
        const again = await world.Channel.Exchange(signer.Sign(MessageKind.HiveKeyRotation, Participant.Platform, rotation))
        assert.ok(again !== null)
        assert.equal(HiveKeyRotationAck.Parse(again.Body).KeyId, next.KeyId)
        // Anything else under the previous key stays refused, and so is a rotation to yet another key.
        await assert.rejects(world.Channel.Exchange(signer.Sign(MessageKind.HiveReport, Participant.Platform, RotationCases.Report())), RotationCases.Refused(AgentExchangeRefusal.NotVerified))
        const other = HiveKeyRotation.Create(hive.Self.Id, old.KeyId, SigningKeyPair.Generate())
        await assert.rejects(world.Channel.Exchange(signer.Sign(MessageKind.HiveKeyRotation, Participant.Platform, other)), RotationCases.Refused(AgentExchangeRefusal.NotVerified))
        // The new key is used once: the grace ends and the previous key no longer asks.
        await world.Channel.Exchange(new EnvelopeSigner(next, hive.Self, world.Clock).Sign(MessageKind.HiveReport, Participant.Platform, RotationCases.Report()))
        assert.equal((world.Directory.GetHive(hive.Self.Id) as PlatformHiveRecord).previousKeyId, undefined)
        await assert.rejects(world.Channel.Exchange(signer.Sign(MessageKind.HiveKeyRotation, Participant.Platform, rotation)), RotationCases.Refused(AgentExchangeRefusal.NotVerified))
    })

    it('the previous key is accepted for a day at most', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await RotationCases.Hive(world)
        const old = hive.Key
        const rotation = HiveKeyRotation.Create(hive.Self.Id, old.KeyId, SigningKeyPair.Generate())
        await world.Channel.Exchange(new EnvelopeSigner(old, hive.Self, world.Clock).Sign(MessageKind.HiveKeyRotation, Participant.Platform, rotation))
        world.Clock.Advance(PreviousKeyGrace.GraceMs + 60_000)
        await assert.rejects(world.Channel.Exchange(new EnvelopeSigner(old, hive.Self, world.Clock).Sign(MessageKind.HiveKeyRotation, Participant.Platform, rotation)), RotationCases.Refused(AgentExchangeRefusal.NotVerified))
    })

    it('a key switch names the key id of its public key, and only while the hive still holds the key it replaces', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await RotationCases.Hive(world)
        const next = SigningKeyPair.Generate().PublicKey
        await world.Directory.SetHiveConsole(hive.Self.Id, undefined)
        const rotated = await world.Directory.RotateHiveKey(hive.Self.Id, hive.Key.KeyId, next.ToJson())
        assert.equal(rotated.keyId, next.KeyId)
        assert.equal(rotated.previousKeyId, hive.Key.KeyId)
        await assert.rejects(world.Directory.RotateHiveKey(hive.Self.Id, hive.Key.KeyId, SigningKeyPair.Generate().PublicKey.ToJson()), HiveKeyChangedError)
        assert.equal((world.Directory.GetHive(hive.Self.Id) as PlatformHiveRecord).keyId, next.KeyId)
    })
})

