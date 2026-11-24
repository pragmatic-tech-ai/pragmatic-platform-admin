import { AgentExchangeRefusal, Intent, IntentDecision, MessageKind, SignedEnvelope, type IBodyDecoder, type VerifiedMessage } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { PlatformHiveRecords, type PlatformHiveRecord } from '../platform-records.js'
import { AgentExchangeRefusedError, type AgentAnswer, type IAgentMessageHandler } from '../hive-channel/platform-agent-exchange.js'
import type { IntentOutbox } from './intent-outbox.js'

/** Where the deciding hive's record is read. */
export interface IDecidingHives
{
    GetHive(id: string): PlatformHiveRecord | undefined
}

/**
 * A hive's signed IntentDecision (C3.4): the customer approved or rejected an Enrolled intent in the engine's console,
 * signed by the hive key. It must answer an intent issued to that hive by the digest of the exact envelope the
 * platform signed, so an approval can never move onto another intent or a reissue (which has its own id and digest);
 * anything else is refused `not-verified`, as is a decision on an expired, superseded or settled intent, or one that
 * contradicts the decision already kept (the same decision again is acknowledged: a re-sent answer). The decision and its
 * approver (a realm subject) are kept on the intent; a rejection is final. Acknowledged with no answer.
 */
export class IntentDecisionHandler implements IAgentMessageHandler<IntentDecision>
{
    public readonly Kind = MessageKind.IntentDecision
    public readonly Decoder: IBodyDecoder<IntentDecision> = IntentDecision

    public constructor(private readonly hives: IDecidingHives, private readonly outbox: IntentOutbox)
    {
    }

    public async Handle(message: VerifiedMessage<IntentDecision>): Promise<AgentAnswer | null>
    {
        const hive = this.hives.GetHive(message.Issuer.Id)
        if (hive === undefined || PlatformHiveRecords.HasLeft(hive))
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.HiveGone)
        }
        const record = this.outbox.Get(message.Body.IntentId)
        if (record === undefined || record.hiveId !== hive.id)
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.NotVerified)
        }
        const issued = SignedEnvelope.Decode(record.envelope)
        if (!message.Body.Answers(issued, Intent.Parse(issued.Body)))
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.NotVerified)
        }
        if (await this.outbox.RecordDecision(record.id, message.Body) !== undefined)
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.NotVerified)
        }
        return null
    }
}
