import { JsonRecordStore, type IRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/** Where a hosted placement stands: requested by a customer admin; C5.1 places it on our machines. */
export enum PlacementState
{
    Requested = 'requested',
    Placed = 'placed',
}

/** A customer's request for a Hosted hive of a tenant. */
export type PlacementRecord = {
    id: string
    clientId: string
    tenantId: string
    state: PlacementState
    /** The subject key of the customer admin who asked. */
    requestedBy: string
    requestedAt: string
}

export class PlacementStore extends JsonRecordStore<PlacementRecord>
{
    public static readonly RootKey = 'placements'

    public constructor(location: string | IRecordMap<PlacementRecord>)
    {
        super(location, PlacementStore.RootKey)
    }
}
