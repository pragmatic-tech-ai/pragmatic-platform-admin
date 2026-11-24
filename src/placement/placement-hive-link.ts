import { ClusterCredentialHandover } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { PlatformHiveRecord } from '../platform-records.js'
import { PlacementState, type PlacementRecord } from './placement-record.js'
import type { PlacementRegistry } from './placement-registry.js'

/** The hive records a placed hive is attached to its cluster on (PlatformDirectory). */
export interface IHostedHives
{
    GetHive(id: string): PlatformHiveRecord | undefined
    AttachHostedCluster(hiveId: string, placementId: string, configRef: string): Promise<PlatformHiveRecord>
}

/** What the hive enrolment handler tells about a hive enrolled with a placement's code. */
export interface IPlacementEnrolments
{
    /** Whether a hive may still enrol from the placement (it is scheduled, placed or failed: not removed or cancelled). */
    Accepts(placementId: string): boolean
    HiveEnrolled(placementId: string, hiveId: string): Promise<void>
}

/**
 * Links a placement and the hive enrolled with its code (C5.1), whichever of the two arrives first: the hive's
 * enrolment (the engine in the new cluster enrols itself with the placement's one-time code) or the host's placed
 * result. Once both are in, the hive record gets its cluster spec `{ backend: 'local', mode: 'attach', configRef:
 * 'clusters/<placement>' }`, so the platform drives it by push through the per-cluster credential. Applying twice is a
 * no-op, so the scheduler re-applies every placed placement on its tick (a crash between the two writes heals).
 */
export class PlacementHiveLink implements IPlacementEnrolments
{
    private static readonly Linkable: ReadonlySet<PlacementState> = new Set([PlacementState.Scheduled, PlacementState.Placed, PlacementState.Failed, PlacementState.Removing])

    public constructor(private readonly placements: PlacementRegistry, private readonly hives: IHostedHives)
    {
    }

    public Accepts(placementId: string): boolean
    {
        const placement = this.placements.Get(placementId)
        return placement !== undefined && PlacementHiveLink.Linkable.has(placement.state)
    }

    public async HiveEnrolled(placementId: string, hiveId: string): Promise<void>
    {
        await this.Apply(await this.placements.LinkHive(placementId, hiveId))
    }

    /** Attaches the placement's hive to its cluster once the placement is placed and its hive enrolled. */
    public async Apply(placement: PlacementRecord): Promise<void>
    {
        if (placement.hiveId === undefined || placement.state !== PlacementState.Placed || this.hives.GetHive(placement.hiveId) === undefined)
        {
            return
        }
        await this.hives.AttachHostedCluster(placement.hiveId, placement.id, ClusterCredentialHandover.ReferenceFor(placement.id))
    }
}
