import { JsonRecordStore, type IRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { FreshnessPolicy, MessageKind, Participant, SignedEnvelope, type EnvelopeSigner, type PlacementRequest } from '@pragmatic-tech-ai/pragmatic-hive-protocol'

/** One signed placement request waiting in a host's queue (its wire text, verified by the host item by item). */
export type PlacementQueueRecord = {
    /** `<host id>.<sequence>` */
    id: string
    hostId: string
    sequence: number
    placementId: string
    envelope: string
    issuedAt: string
    expiresAt: string
}

export class PlacementQueueStore extends JsonRecordStore<PlacementQueueRecord>
{
    public static readonly RootKey = 'placementQueue'

    public constructor(location: string | IRecordMap<PlacementQueueRecord>)
    {
        super(location, PlacementQueueStore.RootKey)
    }
}

/** Where the queue takes a host's next sequence (HostRegistry). */
export interface IQueueSequences
{
    TakeSequence(hostId: string): Promise<number>
    Get(hostId: string): { lastSequence?: number } | undefined
}

/** One pull's answer: the items to send and the cursor to pull after next. */
export type PlacementQueueBatch = { Items: readonly SignedEnvelope[]; Cursor: number }

/**
 * The per-host outbox of signed PlacementRequests (C5.1), cursor-ordered by a per-host sequence that is never reused.
 * Each request is signed by the platform (the trust root) to `Participant.Host(id)` as a standing order (seven days).
 * A pull answers the requests after the cursor, only the newest one per placement (an older place or a place before a
 * removal would only be undone), at most `max`; a cursor the platform does not know (beyond the host's last sequence:
 * the platform was restored) answers from the start of the queue, never skipping. Expired requests are pruned when the
 * next one is published, so a request still owed after its expiry is published again by the scheduler.
 */
export class PlacementQueue
{
    /** A placement request stands seven days (the standing default); its hive code lives exactly as long. */
    public static readonly RequestLifetimeMs = FreshnessPolicy.Standing.DefaultLifetimeMs
    private static readonly IdSeparator = '.'

    public constructor(private readonly store: PlacementQueueStore, private readonly sequences: IQueueSequences, private readonly signer: EnvelopeSigner, private readonly now: () => Date = () => new Date())
    {
    }

    /** Signs and enqueues `request` for the host; answers its sequence and expiry. */
    public async Publish(hostId: string, request: PlacementRequest): Promise<{ Sequence: number; ExpiresAt: Date }>
    {
        await this.Prune()
        const envelope = this.signer.Sign(MessageKind.PlacementRequest, Participant.Host(hostId), request, PlacementQueue.RequestLifetimeMs)
        const sequence = await this.sequences.TakeSequence(hostId)
        // An older request of the placement is superseded: it would never be answered again, and it may carry a hive code.
        await this.Settle(hostId, request.PlacementId, sequence - 1)
        await this.store.Put({
            id: hostId + PlacementQueue.IdSeparator + String(sequence), hostId, sequence, placementId: request.PlacementId, envelope: envelope.Encode(),
            issuedAt: envelope.IssuedAt.toISOString(), expiresAt: envelope.ExpiresAt.toISOString(),
        })
        return { Sequence: sequence, ExpiresAt: envelope.ExpiresAt }
    }

    /**
     * Drops the placement's requests up to `sequence` from the host's queue: its host answered them (a result for that
     * version), or a newer one superseded them. A request carries the hive's one-time code, so it is kept no longer.
     */
    public async Settle(hostId: string, placementId: string, sequence: number): Promise<void>
    {
        for (const record of this.store.List())
        {
            if (record.hostId === hostId && record.placementId === placementId && record.sequence <= sequence)
            {
                await this.store.Remove(record.id)
            }
        }
    }

    public After(hostId: string, after: number, max: number): PlacementQueueBatch
    {
        const last = this.sequences.Get(hostId)?.lastSequence ?? 0
        const from = after > last ? 0 : after
        const now = this.now().getTime()
        const pending = this.store.List()
            .filter(record => record.hostId === hostId && record.sequence > from && Date.parse(record.expiresAt) > now)
            .sort((a, b) => a.sequence - b.sequence)
        const newest = new Map<string, PlacementQueueRecord>()
        for (const record of pending)
        {
            newest.set(record.placementId, record)
        }
        const items = [...newest.values()].sort((a, b) => a.sequence - b.sequence)
        const sent = items.slice(0, Math.max(0, max))
        // The cursor passes everything up to the newest item sent; superseded items before it are never needed again.
        const cursor = sent.length === items.length ? Math.max(from, pending.at(-1)?.sequence ?? from) : (sent.at(-1)?.sequence ?? from)
        return { Items: sent.map(record => SignedEnvelope.Decode(record.envelope)), Cursor: cursor }
    }

    private async Prune(): Promise<void>
    {
        const now = this.now().getTime()
        for (const record of this.store.List())
        {
            if (Date.parse(record.expiresAt) <= now)
            {
                await this.store.Remove(record.id)
            }
        }
    }
}
