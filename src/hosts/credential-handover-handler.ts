import { AgentExchangeRefusal, ClusterCredentialHandover, MessageKind, ParticipantRole, type IBodyDecoder, type SealingKeyPair, type VerifiedMessage } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { AgentExchangeRefusedError, type AgentAnswer, type IAgentMessageHandler } from '../hive-channel/platform-agent-exchange.js'
import { PlacementState, type PlacementRecord } from '../placement/placement-record.js'
import { HandedOverKubeconfig } from './handed-over-kubeconfig.js'

/** The placements a handover is checked against and recorded on (PlacementRegistry). */
export interface IHandoverPlacements
{
    Get(id: string): PlacementRecord | undefined
    RecordCredential(id: string, rotation: number, expiresAt: Date, port: number): Promise<PlacementRecord>
}

/** Where the handing-over host's mesh address is read (HostRegistry). */
export interface IHandoverHosts
{
    Get(id: string): { meshAddress: string } | undefined
}

/** Where an opened credential is kept: the platform's sealed secret store (sealed under the master key). */
export interface IClusterCredentials
{
    Put(ref: string, value: Buffer): Promise<void>
}

/**
 * A host's sealed cluster credential (C5.1): verified against the host's key, then opened with the platform's X25519
 * sealing key, strictly parsed (HandedOverKubeconfig: one cluster CA and one bearer token, nothing else, on the host's
 * mesh address) and stored REBUILT by the platform (server `https://<host mesh address>:<placement port>`) in the
 * sealed secret store under `clusters/<placement>` (the blob itself is never stored); any other kubeconfig is refused
 * `malformed`, another port than the placement's `mismatch`. A blob sealed to another key (the platform's sealing key
 * is one key; rotating it means re-enrolling every host) does not open: `not-verified`.
 * Refused: a placement that is not this host's or no longer open (`mismatch`), a rotation number at or below the stored
 * one (`replayed`: an old credential never overwrites a newer one), a blob that does not open for this host, placement,
 * reference, rotation and expiry (`not-verified`: a blob moved from another message). One handover at a time, so two
 * rotations never race. Acknowledged with no answer (204).
 */
export class CredentialHandoverHandler implements IAgentMessageHandler<ClusterCredentialHandover>
{
    public readonly Kind = MessageKind.ClusterCredentialHandover
    public readonly Issuer = ParticipantRole.Host
    public readonly Decoder: IBodyDecoder<ClusterCredentialHandover> = ClusterCredentialHandover
    private static readonly OpenStates: ReadonlySet<PlacementState> = new Set([PlacementState.Scheduled, PlacementState.Placed])
    private turn: Promise<unknown> = Promise.resolve()

    public constructor(private readonly placements: IHandoverPlacements, private readonly credentials: IClusterCredentials, private readonly sealingKey: SealingKeyPair, private readonly hosts: IHandoverHosts)
    {
    }

    public Handle(message: VerifiedMessage<ClusterCredentialHandover>): Promise<AgentAnswer | null>
    {
        const next = this.turn.then(() => this.Take(message))
        this.turn = next.catch(() => undefined)
        return next
    }

    private async Take(message: VerifiedMessage<ClusterCredentialHandover>): Promise<AgentAnswer | null>
    {
        const handover = message.Body
        const placement = this.placements.Get(handover.PlacementId)
        if (placement === undefined || placement.hostId !== message.Issuer.Id || !CredentialHandoverHandler.OpenStates.has(placement.state)
            || handover.CredentialReference !== ClusterCredentialHandover.ReferenceFor(placement.id))
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.Mismatch)
        }
        if (handover.Rotation <= (placement.credentialRotation ?? 0))
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.Replayed)
        }
        const host = this.hosts.Get(message.Issuer.Id)
        if (host === undefined)
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.NotVerified)
        }
        let credential: Buffer
        try
        {
            credential = handover.Open(this.sealingKey, message.Issuer)
        }
        catch
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.NotVerified)
        }
        let rebuilt: Buffer
        let port: number
        try
        {
            const parsed = HandedOverKubeconfig.Parse(credential, host.meshAddress)
            port = parsed.Port
            if (placement.apiPort !== undefined && placement.apiPort !== port)
            {
                throw new AgentExchangeRefusedError(AgentExchangeRefusal.Mismatch)
            }
            rebuilt = parsed.Rebuild(host.meshAddress, port)
        }
        catch (error)
        {
            throw error instanceof AgentExchangeRefusedError ? error : new AgentExchangeRefusedError(AgentExchangeRefusal.Malformed)
        }
        finally
        {
            credential.fill(0)
        }
        try
        {
            await this.credentials.Put(handover.CredentialReference, rebuilt)
        }
        finally
        {
            rebuilt.fill(0)
        }
        await this.placements.RecordCredential(placement.id, handover.Rotation, handover.ExpiresAt, port)
        return null
    }
}
