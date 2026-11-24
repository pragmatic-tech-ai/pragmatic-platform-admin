import { AgentExchangeRefusal, ClusterCredentialHandover, MessageKind, ParticipantRole, PlacementOutcome, PlacementResult, type IBodyDecoder, type VerifiedMessage } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { AgentExchangeRefusedError, type AgentAnswer, type IAgentMessageHandler } from '../hive-channel/platform-agent-exchange.js'
import type { PlacementHiveLink } from './placement-hive-link.js'
import { PlacementState, type PlacementRecord } from './placement-record.js'
import type { PlacementRegistry } from './placement-registry.js'

/** Where a removed placement's cluster credential is deleted (the sealed secret store). */
export interface IClusterCredentialRemoval
{
    Delete(ref: string): Promise<void>
}

/**
 * A host's PlacementResult (C5.1), retried by the host until acknowledged, so every outcome is idempotent and an
 * outcome that no longer applies is acknowledged without a change. Placed: the placement is placed (a first placement,
 * or an engine upgrade confirmed) and, once its hive enrolled, the hive record is attached to `clusters/<placement>`.
 * Failed: a first placement is failed with the host's code (its slot free again); a placed hive's failed upgrade is
 * recorded and the hive stays placed. Removed: the placement is removed and its cluster credential deleted from the
 * secret store; a removal of a placement the platform does not know is acknowledged (idempotent). A result for another
 * host's placement, or a placed or failed one for an unknown placement, is refused `mismatch`. One result at a time.
 */
export class PlacementResultHandler implements IAgentMessageHandler<PlacementResult>
{
    public readonly Kind = MessageKind.PlacementResult
    public readonly Issuer = ParticipantRole.Host
    public readonly Decoder: IBodyDecoder<PlacementResult> = PlacementResult
    private turn: Promise<unknown> = Promise.resolve()

    public constructor(private readonly placements: PlacementRegistry, private readonly link: PlacementHiveLink, private readonly credentials: IClusterCredentialRemoval)
    {
    }

    public Handle(message: VerifiedMessage<PlacementResult>): Promise<AgentAnswer | null>
    {
        const next = this.turn.then(() => this.Take(message))
        this.turn = next.catch(() => undefined)
        return next
    }

    private async Take(message: VerifiedMessage<PlacementResult>): Promise<AgentAnswer | null>
    {
        const result = message.Body
        const placement = this.placements.Get(result.PlacementId)
        if (placement === undefined)
        {
            if (result.Outcome === PlacementOutcome.Removed)
            {
                return null
            }
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.Mismatch)
        }
        if (placement.hostId !== message.Issuer.Id)
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.Mismatch)
        }
        switch (result.Outcome)
        {
            case PlacementOutcome.Placed:
                await this.Placed(placement, result)
                break
            case PlacementOutcome.Failed:
                await this.Failed(placement, result)
                break
            case PlacementOutcome.Removed:
                await this.Removed(placement)
                break
        }
        return null
    }

    private async Placed(placement: PlacementRecord, result: PlacementResult): Promise<void>
    {
        if ((placement.state !== PlacementState.Scheduled && placement.state !== PlacementState.Placed) || result.ApiServer === null)
        {
            return
        }
        const placed = await this.placements.MarkPlaced(placement.id, { host: result.ApiServer.Host, port: result.ApiServer.Port })
        await this.link.Apply(placed)
    }

    private async Failed(placement: PlacementRecord, result: PlacementResult): Promise<void>
    {
        if ((placement.state !== PlacementState.Scheduled && placement.state !== PlacementState.Placed) || result.Failure === null)
        {
            return
        }
        await this.placements.MarkFailed(placement.id, result.Failure)
    }

    private async Removed(placement: PlacementRecord): Promise<void>
    {
        if (placement.state === PlacementState.Removing)
        {
            await this.credentials.Delete(ClusterCredentialHandover.ReferenceFor(placement.id))
            await this.placements.MarkRemoved(placement.id)
            return
        }
        if (placement.state === PlacementState.Removed)
        {
            // A retry after the acknowledgement was lost: the credential stays deleted.
            await this.credentials.Delete(ClusterCredentialHandover.ReferenceFor(placement.id))
        }
    }
}
