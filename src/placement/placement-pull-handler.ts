import { AgentExchangeRefusal, MessageKind, ParticipantRole, Pull, PullBatch, type IBodyDecoder, type VerifiedMessage } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { AgentAnswer, AgentExchangeRefusedError, type IAgentMessageHandler } from '../hive-channel/platform-agent-exchange.js'
import type { PlacementQueueBatch } from './placement-queue.js'

/** The host's queue (PlacementQueue) and whether the host is enrolled (HostRegistry). */
export interface IPlacementPulls
{
    After(hostId: string, after: number, max: number): PlacementQueueBatch
}

export interface IPullingHosts
{
    Get(id: string): unknown
}

/**
 * A host agent's Pull (C5.1): verified against the host's key, answered with a signed PullBatch of the placement
 * requests in its queue after the cursor (each its own signed envelope, addressed to that host) and the next cursor.
 * Only for issuers of role host; a hive's Pull is another handler's (its intents).
 */
export class PlacementPullHandler implements IAgentMessageHandler<Pull>
{
    public readonly Kind = MessageKind.Pull
    public readonly Issuer = ParticipantRole.Host
    public readonly Decoder: IBodyDecoder<Pull> = Pull

    public constructor(private readonly hosts: IPullingHosts, private readonly queue: IPlacementPulls)
    {
    }

    public Handle(message: VerifiedMessage<Pull>): Promise<AgentAnswer>
    {
        if (this.hosts.Get(message.Issuer.Id) === undefined)
        {
            return Promise.reject(new AgentExchangeRefusedError(AgentExchangeRefusal.NotVerified))
        }
        const batch = this.queue.After(message.Issuer.Id, message.Body.After, message.Body.Max)
        return Promise.resolve(new AgentAnswer(MessageKind.PullBatch, PullBatch.Create(batch.Items, batch.Cursor)))
    }
}
