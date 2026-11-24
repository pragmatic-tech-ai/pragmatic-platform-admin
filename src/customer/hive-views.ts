import { EnvironmentReport, HiveHealth, HiveLevel, HiveView } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { ComponentState } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { HiveObservationRecord } from '../hive-observation-record.js'
import { PlacementState, type PlacementRecord } from '../placement/placement-record.js'
import { PlatformHiveRecords, type PlatformHiveRecord } from '../platform-records.js'

/**
 * A hive as its customer admin sees it. Health from the hive's last report: none yet is `pending`; a report at most two
 * minutes old is `healthy` when every environment is ready (and, for a signed report, every component), else `degraded`; older than two minutes but within ten,
 * `degraded` (late); older than ten minutes, `unreachable`; a hive its customer left is `gone`. Home: the hive serves
 * its tenant's console. An environment reports its name, readiness and the image it runs (as its version, when it fits).
 */
export class HiveViews
{
    public static readonly FreshMs = 2 * 60 * 1000
    public static readonly UnreachableMs = 10 * 60 * 1000

    public static Of(hive: PlatformHiveRecord, observation: HiveObservationRecord | undefined, now: Date): HiveView
    {
        const reportedAt = observation === undefined ? null : new Date(observation.reportedAt)
        const environments = (observation?.environments ?? []).slice(0, HiveView.MaxEnvironments).map(environment =>
            new EnvironmentReport(environment.environmentName.slice(0, EnvironmentReport.MaxName), environment.ready, HiveViews.VersionOf(environment.runningImage)))
        return new HiveView(hive.id, hive.tenantId, PlatformHiveRecords.LevelOf(hive), PlatformHiveRecords.ServesConsole(hive), HiveViews.HealthOf(hive, observation, reportedAt, environments, now), reportedAt, environments)
    }

    /** An open placement: a Hosted hive the platform has not placed yet (pending); a cancelled one is gone. */
    public static OfPlacement(placement: PlacementRecord): HiveView
    {
        const health = placement.state === PlacementState.Cancelled ? HiveHealth.Gone : HiveHealth.Pending
        return new HiveView(placement.id, placement.tenantId, HiveLevel.Hosted, false, health, null, [])
    }

    private static HealthOf(hive: PlatformHiveRecord, observation: HiveObservationRecord | undefined, reportedAt: Date | null, environments: readonly EnvironmentReport[], now: Date): HiveHealth
    {
        if (PlatformHiveRecords.HasLeft(hive))
        {
            return HiveHealth.Gone
        }
        if (reportedAt === null)
        {
            return HiveHealth.Pending
        }
        const age = now.getTime() - reportedAt.getTime()
        if (age > HiveViews.UnreachableMs)
        {
            return HiveHealth.Unreachable
        }
        if (age > HiveViews.FreshMs)
        {
            return HiveHealth.Degraded
        }
        const componentsReady = (observation?.components ?? []).every(component => component.state === ComponentState.Ready)
        return componentsReady && environments.every(environment => environment.Ready) ? HiveHealth.Healthy : HiveHealth.Degraded
    }

    private static VersionOf(runningImage: string | undefined): string | null
    {
        return runningImage === undefined || runningImage.length > EnvironmentReport.MaxVersion ? null : runningImage
    }
}
