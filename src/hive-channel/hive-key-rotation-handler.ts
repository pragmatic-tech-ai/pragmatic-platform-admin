import { AgentExchangeRefusal, HiveKeyRotation, HiveKeyRotationAck, MessageKind, type IBodyDecoder, type VerifiedMessage } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { PlatformHiveRecords, type PlatformHiveRecord } from '../platform-records.js'
import { AgentAnswer, AgentExchangeRefusedError, type IAgentMessageHandler } from './platform-agent-exchange.js'
import { HiveKeyChangedError } from '../platform-directory.js'

/** Where a rotating hive's key is read and switched (PlatformDirectory). */
export interface IRotatingHives
{
    GetHive(id: string): PlatformHiveRecord | undefined
    HiveByKeyId(keyId: string): PlatformHiveRecord | undefined
    RotateHiveKey(id: string, expectedKeyId: string, publicKey: string): Promise<PlatformHiveRecord>
}

/**
 * A hive's signed HiveKeyRotation (C3.4): verified under the hive's current key, naming that hive and that key as the
 * one it replaces, with a new key that proves itself and is registered to no hive. The record's key is switched in one
 * write (only while it is still the key the rotation names), so the old key is refused for everything else from the
 * next message on, and the platform answers HiveKeyRotationAck naming the new key id (the agent swaps keys only then).
 * A hive whose acknowledgement was lost asks again under its previous key (PreviousKeyGrace: until it first uses the new
 * key, at most a day): a rotation to the key it already rotated to is acknowledged again, nothing changes. Rotations are
 * taken one at a time. Anything else is refused `not-verified` (`key-registered` for a key already in use); a left hive
 * `hive-gone`.
 */
export class HiveKeyRotationHandler implements IAgentMessageHandler<HiveKeyRotation>
{
    public readonly Kind = MessageKind.HiveKeyRotation
    public readonly Decoder: IBodyDecoder<HiveKeyRotation> = HiveKeyRotation
    private turn: Promise<unknown> = Promise.resolve()

    public constructor(private readonly hives: IRotatingHives)
    {
    }

    public Handle(message: VerifiedMessage<HiveKeyRotation>): Promise<AgentAnswer>
    {
        const next = this.turn.then(() => this.Rotate(message))
        this.turn = next.catch(() => undefined)
        return next
    }

    private async Rotate(message: VerifiedMessage<HiveKeyRotation>): Promise<AgentAnswer>
    {
        const rotation = message.Body
        const hive = this.hives.GetHive(message.Issuer.Id)
        if (hive === undefined || PlatformHiveRecords.HasLeft(hive))
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.HiveGone)
        }
        const signedBy = message.Envelope.KeyId
        if (rotation.HiveId !== hive.id || rotation.PreviousKeyId !== signedBy || !rotation.Proven)
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.NotVerified)
        }
        const newKeyId = rotation.NewPublicKey.KeyId
        if (signedBy === hive.previousKeyId && signedBy !== hive.keyId)
        {
            // The lost acknowledgement asked again: only the rotation that already happened is answered.
            if (newKeyId !== hive.keyId)
            {
                throw new AgentExchangeRefusedError(AgentExchangeRefusal.NotVerified)
            }
            return HiveKeyRotationHandler.Ack(hive.id, newKeyId)
        }
        if (hive.keyId !== signedBy)
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.NotVerified)
        }
        if (this.hives.HiveByKeyId(newKeyId) !== undefined)
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.KeyRegistered)
        }
        try
        {
            await this.hives.RotateHiveKey(hive.id, signedBy, rotation.NewPublicKey.ToJson())
        }
        catch (error)
        {
            if (error instanceof HiveKeyChangedError)
            {
                throw new AgentExchangeRefusedError(AgentExchangeRefusal.NotVerified)
            }
            throw error
        }
        return HiveKeyRotationHandler.Ack(hive.id, newKeyId)
    }

    private static Ack(hiveId: string, keyId: string): AgentAnswer
    {
        return new AgentAnswer(MessageKind.HiveKeyRotationAck, HiveKeyRotationAck.Create(hiveId, keyId))
    }
}
