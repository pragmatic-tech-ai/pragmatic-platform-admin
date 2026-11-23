import { randomBytes } from 'node:crypto'
import type { IHiveReservations } from '../customer/client-usage.js'
import { PlacementState, type PlacementRecord, type PlacementStore } from './placement-record.js'

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
