import { randomBytes } from 'node:crypto'
import type { IHiveReservations } from '../customer/client-usage.js'
import { PlacementState, type PlacementRecord, type PlacementStore } from './placement-record.js'

/** The placement is not an open one (unknown, placed or already cancelled). */
export class PlacementNotOpenError extends Error
{
    private static readonly ErrorName = 'PlacementNotOpenError'
    private static readonly MessagePrefix = 'No open placement: '

    public constructor(id: string)
    {
        super(PlacementNotOpenError.MessagePrefix + id)
        this.name = PlacementNotOpenError.ErrorName
    }
}

/**
 * The placements customers request for Hosted hives. Request records one in state `requested` (C5.1 moves it on); an
 * open (requested) placement reserves one of the client's hives (IHiveReservations). Ids are `pl-` plus 16 random
 * base32 characters, a DNS label like a hive id.
 */
export class PlacementRegistry implements IHiveReservations
{
    public static readonly IdPrefix = 'pl-'
    private static readonly Alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
    private static readonly IdCharacters = 16
    private static readonly CharacterMask = 31

    public constructor(private readonly store: PlacementStore, private readonly now: () => Date = () => new Date())
    {
    }

    public async Request(clientId: string, tenantId: string, requestedBy: string): Promise<PlacementRecord>
    {
        const record: PlacementRecord = { id: PlacementRegistry.NewId(), clientId, tenantId, state: PlacementState.Requested, requestedBy, requestedAt: this.now().toISOString() }
        await this.store.Put(record)
        return record
    }

    /** The client's open (requested) placement `id`, or undefined. */
    public OpenOf(clientId: string, id: string): PlacementRecord | undefined
    {
        const record = this.store.Get(id)
        return record !== undefined && record.clientId === clientId && record.state === PlacementState.Requested ? record : undefined
    }

    /** Withdraws an open placement (state cancelled): it stops counting against the client's hives and leaves the list. */
    public async Cancel(id: string): Promise<PlacementRecord>
    {
        const record = this.store.Get(id)
        if (record === undefined || record.state !== PlacementState.Requested)
        {
            throw new PlacementNotOpenError(id)
        }
        const cancelled: PlacementRecord = { ...record, state: PlacementState.Cancelled, cancelledAt: this.now().toISOString() }
        await this.store.Put(cancelled)
        return cancelled
    }

    /** The client's open (requested) placements, of one tenant or of all. */
    public OpenFor(clientId: string, tenantId?: string): readonly PlacementRecord[]
    {
        return this.store.List().filter(record => record.clientId === clientId && record.state === PlacementState.Requested && (tenantId === undefined || record.tenantId === tenantId))
    }

    public OutstandingFor(clientId: string, _now: Date): number
    {
        return this.OpenFor(clientId).length
    }

    private static NewId(): string
    {
        const P = PlacementRegistry
        const characters = [...randomBytes(P.IdCharacters)].map(byte => P.Alphabet[byte & P.CharacterMask] as string)
        return P.IdPrefix + characters.join('')
    }
}
