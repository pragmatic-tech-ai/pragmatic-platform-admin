import { randomBytes } from 'node:crypto'
import type { PlacementFailure } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { IHiveReservations } from '../customer/client-usage.js'
import { PlacementState, type PlacementApiServer, type PlacementRecord, type PlacementStore } from './placement-record.js'

/** The placement is not in a state the asked move starts from (unknown, or already past it). */
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

/** Where a scheduled placement goes and what it installs. */
export interface PlacementSchedule
{
    HostId: string
    Label: string
    HiveHostName: string
    EngineVersion: string
    ChartDigest: string
}

/**
 * The placements customers request for Hosted hives (D4) and their way through C5.1: requested → scheduled → placed |
 * failed → removing → removed (cancelled while still requested). Every move checks the state it starts from and stages
 * the new record before its first await (JsonRecordStore stages synchronously), so two moves of one placement never
 * both pass. A placement that has no hive yet and is not failed or gone reserves one of the client's hives
 * (IHiveReservations); once its hive enrolled, the hive record counts instead. Ids are `pl-` plus 16 random base32
 * characters, a DNS label like a hive id.
 */
export class PlacementRegistry implements IHiveReservations
{
    public static readonly IdPrefix = 'pl-'
    private static readonly Alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
    private static readonly IdCharacters = 16
    private static readonly CharacterMask = 31
    /** States that hold a slot on their host (a failed placement's slot is free; removing still holds it). */
    private static readonly HoldingSlot: ReadonlySet<PlacementState> = new Set([PlacementState.Scheduled, PlacementState.Placed, PlacementState.Removing])
    /** States a customer still sees as a pending hosted hive while no hive enrolled from it. */
    private static readonly Shown: ReadonlySet<PlacementState> = new Set([PlacementState.Requested, PlacementState.Scheduled, PlacementState.Placed, PlacementState.Failed])
    /** States that reserve a client's hive while no hive enrolled from it. */
    private static readonly Reserving: ReadonlySet<PlacementState> = new Set([PlacementState.Requested, PlacementState.Scheduled, PlacementState.Placed])
    /** States a removal may start from (a requested one is cancelled instead). */
    private static readonly Removable: ReadonlySet<PlacementState> = new Set([PlacementState.Scheduled, PlacementState.Placed, PlacementState.Failed])

    public constructor(private readonly store: PlacementStore, private readonly now: () => Date = () => new Date())
    {
    }

    public async Request(clientId: string, tenantId: string, requestedBy: string): Promise<PlacementRecord>
    {
        const record: PlacementRecord = { id: PlacementRegistry.NewId(), clientId, tenantId, state: PlacementState.Requested, requestedBy, requestedAt: this.Stamp() }
        await this.store.Put(record)
        return record
    }

    public Get(id: string): PlacementRecord | undefined
    {
        return this.store.Get(id)
    }

    public List(): readonly PlacementRecord[]
    {
        return this.store.List()
    }

    /** The client's open (requested) placement `id`, or undefined. */
    public OpenOf(clientId: string, id: string): PlacementRecord | undefined
    {
        const record = this.store.Get(id)
        return record !== undefined && record.clientId === clientId && record.state === PlacementState.Requested ? record : undefined
    }

    /** The client's placement `id` as the customer sees it (no hive enrolled from it yet, not gone), or undefined. */
    public ShownOf(clientId: string, id: string): PlacementRecord | undefined
    {
        const record = this.store.Get(id)
        return record !== undefined && record.clientId === clientId && PlacementRegistry.IsShown(record) ? record : undefined
    }

    /** Withdraws a requested placement (state cancelled): it stops counting against the client's hives and leaves the list. */
    public Cancel(id: string): Promise<PlacementRecord>
    {
        return this.Move(id, [PlacementState.Requested], record => ({ ...record, state: PlacementState.Cancelled, cancelledAt: this.Stamp() }))
    }

    /** The client's open (requested) placements, of one tenant or of all. */
    public OpenFor(clientId: string, tenantId?: string): readonly PlacementRecord[]
    {
        return this.store.List().filter(record => record.clientId === clientId && record.state === PlacementState.Requested && (tenantId === undefined || record.tenantId === tenantId))
    }

    /** The client's placements a customer sees as pending hosted hives (no hive enrolled from them yet), of one tenant or all. */
    public ShownFor(clientId: string, tenantId?: string): readonly PlacementRecord[]
    {
        return this.store.List().filter(record => record.clientId === clientId && PlacementRegistry.IsShown(record) && (tenantId === undefined || record.tenantId === tenantId))
    }

    public OutstandingFor(clientId: string, _now: Date): number
    {
        return this.store.List().filter(record => record.clientId === clientId && record.hiveId === undefined && PlacementRegistry.Reserving.has(record.state)).length
    }

    /** The placements waiting for a host. */
    public Requested(): readonly PlacementRecord[]
    {
        return this.store.List().filter(record => record.state === PlacementState.Requested)
    }

    /** The placements whose newest request (a place or a removal) is still owed to their host's queue. */
    public Owed(): readonly PlacementRecord[]
    {
        return this.store.List().filter(record => record.requestSequence === undefined && record.hostId !== undefined
            && (record.state === PlacementState.Scheduled || record.state === PlacementState.Placed || record.state === PlacementState.Removing))
    }

    /** The placed placements. */
    public Placed(): readonly PlacementRecord[]
    {
        return this.store.List().filter(record => record.state === PlacementState.Placed)
    }

    /** The placements holding a slot on the host (scheduled, placed, removing). */
    public HoldingSlotOn(hostId: string): readonly PlacementRecord[]
    {
        return this.store.List().filter(record => record.hostId === hostId && PlacementRegistry.HoldingSlot.has(record.state))
    }

    /** Whether a placement already has this hive label. */
    public LabelTaken(label: string): boolean
    {
        return this.store.List().some(record => record.label === label)
    }

    /** The placement a hive enrolled from, if any. */
    public OfHive(hiveId: string): PlacementRecord | undefined
    {
        return this.store.List().find(record => record.hiveId === hiveId)
    }

    /** requested → scheduled on a host, version 1; its request is owed until RecordPublished. */
    public Schedule(id: string, schedule: PlacementSchedule): Promise<PlacementRecord>
    {
        return this.Move(id, [PlacementState.Requested], record =>
        {
            const { requestSequence: _owed, ...rest } = record
            return {
                ...rest, state: PlacementState.Scheduled, hostId: schedule.HostId, scheduledAt: this.Stamp(), label: schedule.Label, hiveHostName: schedule.HiveHostName,
                version: 1, engineVersion: schedule.EngineVersion, chartDigest: schedule.ChartDigest,
            }
        })
    }

    /** The newest request of the placement is in its host's queue at `sequence`, until `expiresAt`. */
    public RecordPublished(id: string, sequence: number, expiresAt: Date): Promise<PlacementRecord>
    {
        return this.Move(id, [PlacementState.Scheduled, PlacementState.Placed, PlacementState.Removing], record => ({ ...record, requestSequence: sequence, requestExpiresAt: expiresAt.toISOString() }))
    }

    /** The newest request left the host's queue unpulled (it expired): it is owed again. */
    public Republish(id: string): Promise<PlacementRecord>
    {
        return this.Move(id, [PlacementState.Scheduled, PlacementState.Placed, PlacementState.Removing], record =>
        {
            const { requestSequence: _owed, ...rest } = record
            return rest
        })
    }

    /** A placed hive's engine upgrade: the next placement version, its request owed. */
    public Upgrade(id: string, engineVersion: string, chartDigest: string): Promise<PlacementRecord>
    {
        return this.Move(id, [PlacementState.Placed], record =>
        {
            const { requestSequence: _owed, upgradeFailure: _failure, ...rest } = record
            return { ...rest, version: (record.version ?? 1) + 1, engineVersion, chartDigest }
        })
    }

    /** The host placed it (a first placement or an upgrade): placed at the requested engine version. */
    public MarkPlaced(id: string, apiServer: PlacementApiServer): Promise<PlacementRecord>
    {
        return this.Move(id, [PlacementState.Scheduled, PlacementState.Placed], record =>
        {
            const { upgradeFailure: _failure, ...rest } = record
            const placed: PlacementRecord = { ...rest, state: PlacementState.Placed, apiServer, apiPort: apiServer.port, placedAt: this.Stamp() }
            if (record.engineVersion !== undefined)
            {
                placed.placedEngineVersion = record.engineVersion
            }
            return placed
        })
    }

    /**
     * The host could not place it. A first placement is failed (its slot free again); a placed hive whose upgrade failed
     * stays placed at its engine version, the failure recorded (no new upgrade is published for the same version).
     */
    public MarkFailed(id: string, failure: PlacementFailure): Promise<PlacementRecord>
    {
        return this.Move(id, [PlacementState.Scheduled, PlacementState.Placed], record => record.state === PlacementState.Placed
            ? { ...record, upgradeFailure: failure }
            : { ...record, state: PlacementState.Failed, failure, failedAt: this.Stamp() })
    }

    /** The hive enrolled with this placement's code (once; the same hive again is a no-op). */
    public LinkHive(id: string, hiveId: string): Promise<PlacementRecord>
    {
        return this.Move(id, [PlacementState.Scheduled, PlacementState.Placed, PlacementState.Removing, PlacementState.Failed], record =>
        {
            if (record.hiveId !== undefined && record.hiveId !== hiveId)
            {
                throw new PlacementNotOpenError(id)
            }
            return { ...record, hiveId }
        })
    }

    /** A credential rotation opened into the secret store, for the API server at `port`. */
    public RecordCredential(id: string, rotation: number, expiresAt: Date, port: number): Promise<PlacementRecord>
    {
        return this.Move(id, [PlacementState.Scheduled, PlacementState.Placed], record => ({ ...record, credentialRotation: rotation, credentialExpiresAt: expiresAt.toISOString(), apiPort: port }))
    }

    /** scheduled, placed or failed → removing; its removal request owed. */
    public BeginRemoval(id: string): Promise<PlacementRecord>
    {
        return this.Move(id, [...PlacementRegistry.Removable], record =>
        {
            const { requestSequence: _owed, ...rest } = record
            // The removal is the placement's next version: a late answer to an older request never completes it.
            return { ...rest, state: PlacementState.Removing, removingAt: this.Stamp(), version: (record.version ?? 0) + 1 }
        })
    }

    /** The host removed it. */
    public MarkRemoved(id: string): Promise<PlacementRecord>
    {
        return this.Move(id, [PlacementState.Removing], record => ({ ...record, state: PlacementState.Removed, removedAt: this.Stamp() }))
    }

    /** Whether a removal may start from the placement's state. */
    public static IsRemovable(record: PlacementRecord): boolean
    {
        return PlacementRegistry.Removable.has(record.state)
    }

    private static IsShown(record: PlacementRecord): boolean
    {
        return record.hiveId === undefined && PlacementRegistry.Shown.has(record.state)
    }

    /** Checks the state, builds and stages the next record before any await. */
    private async Move(id: string, from: readonly PlacementState[], next: (record: PlacementRecord) => PlacementRecord): Promise<PlacementRecord>
    {
        const record = this.store.Get(id)
        if (record === undefined || !from.includes(record.state))
        {
            throw new PlacementNotOpenError(id)
        }
        const moved = next(record)
        await this.store.Put(moved)
        return moved
    }

    private Stamp(): string
    {
        return this.now().toISOString()
    }

    private static NewId(): string
    {
        const P = PlacementRegistry
        const characters = [...randomBytes(P.IdCharacters)].map(byte => P.Alphabet[byte & P.CharacterMask] as string)
        return P.IdPrefix + characters.join('')
    }
}
