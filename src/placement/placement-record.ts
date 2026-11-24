import { JsonRecordStore, type IRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { PlacementFailure } from '@pragmatic-tech-ai/pragmatic-hive-protocol'

/**
 * Where a hosted placement stands (C5.1): requested by a customer admin; scheduled onto a host (its placement request
 * published to that host's queue); placed (the host answered placed) or failed (the host answered a failure code: the
 * slot is free again); removing (a removal published: the customer left) and removed (the host answered removed, the
 * cluster credential deleted). Cancelled: withdrawn while still requested (never published to a host).
 */
export enum PlacementState
{
    Requested = 'requested',
    Scheduled = 'scheduled',
    Placed = 'placed',
    Failed = 'failed',
    Removing = 'removing',
    Removed = 'removed',
    /** The customer withdrew it before it was scheduled (leave-hive on the placement): it no longer counts. */
    Cancelled = 'cancelled',
}

/** The mesh address of a placed cluster's API server, as the host answered it. */
export type PlacementApiServer = {
    host: string
    port: number
}

/**
 * A customer's request for a Hosted hive of a tenant, and where it went. A record written before C5.1 carries only the
 * first six members (and `cancelledAt`) and reads as it did.
 */
export type PlacementRecord = {
    id: string
    clientId: string
    tenantId: string
    state: PlacementState
    /** The subject key of the customer admin who asked. */
    requestedBy: string
    requestedAt: string
    /** When the customer withdrew it (state cancelled). */
    cancelledAt?: string
    /** The host it is scheduled on (from scheduled on). */
    hostId?: string
    scheduledAt?: string
    /** The hive's label (`<tenant>-<4 base32>`) and its host name `<label>.hives.pragmatic-tech.ai`. */
    label?: string
    hiveHostName?: string
    /** The placement version: 1 when first scheduled, one more for each new request (an engine upgrade, the removal);
     *  every request carries it and a host result must answer it. */
    version?: number
    /** The engine version and chart digest of the newest placement request published. */
    engineVersion?: string
    chartDigest?: string
    /** The host queue sequence of the newest request published for this placement; absent while one is still owed. */
    requestSequence?: number
    /** When that request expires unpulled (it is then owed again). */
    requestExpiresAt?: string
    /** The engine version the host last answered placed for. */
    placedEngineVersion?: string
    placedAt?: string
    apiServer?: PlacementApiServer
    /** The hive enrolled with this placement's code (whichever of its enrolment and the placed result came first). */
    hiveId?: string
    /** The newest cluster credential rotation opened into the secret store, and when that credential expires. */
    credentialRotation?: number
    credentialExpiresAt?: string
    /** The API server port on the host's mesh address, fixed by the first credential handed over (or the placed result). */
    apiPort?: number
    /** Why the host could not place it (state failed), or why an engine upgrade failed (still placed). */
    failure?: PlacementFailure
    failedAt?: string
    upgradeFailure?: PlacementFailure
    removingAt?: string
    removedAt?: string
}

export class PlacementStore extends JsonRecordStore<PlacementRecord>
{
    public static readonly RootKey = 'placements'

    public constructor(location: string | IRecordMap<PlacementRecord>)
    {
        super(location, PlacementStore.RootKey)
    }
}
