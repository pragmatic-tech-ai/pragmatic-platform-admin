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

/** Where the answering host's mesh address is read (HostRegistry). */
export interface IResultHosts
{
    Get(id: string): { meshAddress: string } | undefined
}

/** The host queue a result settles (PlacementQueue): the answered requests, with their hive code, are dropped. */
export interface IResultQueue
{
    Settle(hostId: string, placementId: string, sequence: number): Promise<void>
}

/**
 * A host's PlacementResult (C5.1), retried by the host until acknowledged, so every outcome is idempotent and an
 * outcome that no longer applies is acknowledged without a change. Placed: the placement is placed (a first placement,
 * or an engine upgrade confirmed) and, once its hive enrolled, the hive record is attached to `clusters/<placement>`.
 * Failed: a first placement is failed with the host's code (its slot free again); a placed hive's failed upgrade is
 * recorded and the hive stays placed. Removed: the placement is removed and its cluster credential deleted from the
 * secret store; a removal of a placement the platform does not know is acknowledged (idempotent). A result must answer
 * the placement's current version: an older one is acknowledged and changes nothing, a newer one is refused. A result
 * for another host's placement, or a placed or failed one for an unknown placement, is refused `mismatch`. One result
 * at a time.
 */
export class PlacementResultHandler implements IAgentMessageHandler<PlacementResult>
{
    public readonly Kind = MessageKind.PlacementResult
    public readonly Issuer = ParticipantRole.Host
    public readonly Decoder: IBodyDecoder<PlacementResult> = PlacementResult
    private turn: Promise<unknown> = Promise.resolve()

    public constructor(private readonly placements: PlacementRegistry, private readonly link: PlacementHiveLink, private readonly credentials: IClusterCredentialRemoval,
        private readonly hosts: IResultHosts, private readonly queue: IResultQueue)
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
        const current = placement.version ?? 1
        if (result.Version > current)
        {
            // No request of that version was ever published.
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.Mismatch)
        }
        if (result.Version < current)
        {
            // A late answer to an older request (an old version's placed never marks an upgrade or a removal done).
            return null
        }
        const answersCurrent = await this.Apply(placement, result, message.Issuer.Id)
        // The answered request (it carries the hive's code) leaves the host's queue; a late answer to an older
        // operation (a placed after the removal was published) settles nothing.
        if (answersCurrent && placement.requestSequence !== undefined)
        {
            await this.queue.Settle(message.Issuer.Id, placement.id, placement.requestSequence)
        }
        return null
    }

    /** Applies the outcome; true when it answers the placement's current request (a place, or a removal). */
    private async Apply(placement: PlacementRecord, result: PlacementResult, hostId: string): Promise<boolean>
    {
        switch (result.Outcome)
        {
            case PlacementOutcome.Placed:
                return await this.Placed(placement, result, hostId)
            case PlacementOutcome.Failed:
                return await this.Failed(placement, result)
            case PlacementOutcome.Removed:
                return await this.Removed(placement)
        }
    }

    private async Placed(placement: PlacementRecord, result: PlacementResult, hostId: string): Promise<boolean>
    {
        if ((placement.state !== PlacementState.Scheduled && placement.state !== PlacementState.Placed) || result.ApiServer === null)
        {
            return false
        }
        // The API server is the host's own mesh address at the placement's port (fixed by its credential), nothing else.
        if (result.ApiServer.Host !== this.hosts.Get(hostId)?.meshAddress || (placement.apiPort !== undefined && result.ApiServer.Port !== placement.apiPort))
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.Mismatch)
        }
        const placed = await this.placements.MarkPlaced(placement.id, { host: result.ApiServer.Host, port: result.ApiServer.Port })
        await this.link.Apply(placed)
        return true
    }

    private async Failed(placement: PlacementRecord, result: PlacementResult): Promise<boolean>
    {
        if ((placement.state !== PlacementState.Scheduled && placement.state !== PlacementState.Placed) || result.Failure === null)
        {
            return false
        }
        const failed = await this.placements.MarkFailed(placement.id, result.Failure)
        if (failed.state === PlacementState.Failed)
        {
            // A first placement that failed holds no cluster: whatever credential it handed over is gone too.
            await this.credentials.Delete(ClusterCredentialHandover.ReferenceFor(placement.id))
        }
        return true
    }

    private async Removed(placement: PlacementRecord): Promise<boolean>
    {
        if (placement.state === PlacementState.Removing)
        {
            await this.credentials.Delete(ClusterCredentialHandover.ReferenceFor(placement.id))
            await this.placements.MarkRemoved(placement.id)
            return true
        }
        if (placement.state === PlacementState.Removed)
        {
            // A retry after the acknowledgement was lost: the credential stays deleted.
            await this.credentials.Delete(ClusterCredentialHandover.ReferenceFor(placement.id))
        }
        return false
    }
}
