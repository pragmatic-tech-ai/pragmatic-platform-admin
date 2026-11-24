import { AgentExchangeRefusal, MessageKind, ParticipantRole, Pull, PullBatch, SignedEnvelope, type IBodyDecoder, type VerifiedMessage } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { PlatformHiveRecords, type PlatformHiveRecord } from '../platform-records.js'
import { AgentAnswer, AgentExchangeRefusedError, type IAgentMessageHandler } from '../hive-channel/platform-agent-exchange.js'
import type { IntentOutbox } from './intent-outbox.js'
import type { IIntentSequences } from './sql-intent-sequences.js'

/**
 * What one kind of agent pulls (`MessageKind.Pull` is shared by hives and hosts): the batch after the pull's cursor for
 * its verified issuer. A hive pulls intents (HiveIntentPulls); a host pulls placements (C5.1 plugs its source in).
 */
export interface IPullSource
{
    readonly Role: ParticipantRole
    Answer(message: VerifiedMessage<Pull>): Promise<PullBatch>
}

/** Where the pulling hive's record is read. */
export interface IPullingHives
{
    GetHive(id: string): PlatformHiveRecord | undefined
}

/**
 * A hive's intents after its cursor (C3.4): from the outbox (at most the pull's Max, never more than a batch carries),
 * each the envelope exactly as the platform signed it, with the cursor to pull after next (never below the hive's own).
 * A hive its customer left is refused `hive-gone`, one not managed by intents `unsupported-kind`.
 */
export class HiveIntentPulls implements IPullSource
{
    public readonly Role = ParticipantRole.Hive

    public constructor(private readonly hives: IPullingHives, private readonly outbox: IntentOutbox, private readonly sequences: IIntentSequences)
    {
    }

    public async Answer(message: VerifiedMessage<Pull>): Promise<PullBatch>
    {
        const hive = this.hives.GetHive(message.Issuer.Id)
        if (hive === undefined || PlatformHiveRecords.HasLeft(hive))
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.HiveGone)
        }
        if (!PlatformHiveRecords.TakesIntents(hive))
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.UnsupportedKind)
        }
        // The cursor the hive pulled after is kept: no intent is ever numbered at or below it (a restore cannot hide one).
        await this.sequences.Saw(hive.id, message.Body.After)
        const page = this.outbox.After(hive.id, message.Body.After, message.Body.Max)
        return PullBatch.Create(page.Items.map(record => SignedEnvelope.Decode(record.envelope)), page.Next)
    }
}

/**
 * The platform's one handler of `MessageKind.Pull` (the exchange maps a kind to one handler): it dispatches by the
 * verified issuer's role to that role's pull source and answers its batch as a signed PullBatch. A role with no source
 * (hosts until C5.1 adds placements) is refused `unsupported-kind`.
 */
export class PullHandler implements IAgentMessageHandler<Pull>
{
    public readonly Kind = MessageKind.Pull
    public readonly Decoder: IBodyDecoder<Pull> = Pull
    private readonly sources: ReadonlyMap<ParticipantRole, IPullSource>

    public constructor(sources: readonly IPullSource[])
    {
        this.sources = new Map(sources.map(source => [source.Role, source]))
    }

    public async Handle(message: VerifiedMessage<Pull>): Promise<AgentAnswer>
    {
        const source = this.sources.get(message.Issuer.Role)
        if (source === undefined)
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.UnsupportedKind)
        }
        return new AgentAnswer(MessageKind.PullBatch, await source.Answer(message))
    }
}
