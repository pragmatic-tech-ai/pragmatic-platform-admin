import { randomUUID } from 'node:crypto'
import { EnvironmentReadiness, type ComponentState, type HiveReport, type IntentProgress } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { JsonRecordStore, type IRecordMap, type HiveHealthDto } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

export type HiveObservationRecord = {
    id: string
    hiveId: string
    environments: HiveHealthDto[]
    reportedAt: string
    /** From a signed HiveReport (C3.3) only: the engine version and the closed component and intent states. */
    engineVersion?: string
    components?: ObservedComponent[]
    intents?: ObservedIntent[]
}

/** A component's state as a signed report carried it. */
export type ObservedComponent = {
    component: string
    state: ComponentState
    version: string | null
}

/** An intent's progress as a signed report carried it. */
export type ObservedIntent = {
    intentId: string
    progress: IntentProgress
}

export class HiveObservationRegistry extends JsonRecordStore<HiveObservationRecord>
{
    public static readonly RootKey = 'hiveObservations'
    private static readonly MaxPerHive = 50

    public constructor(location: string | IRecordMap<HiveObservationRecord>)
    {
        super(location, HiveObservationRegistry.RootKey)
    }

    public async RecordSnapshot(hiveId: string, environments: HiveHealthDto[]): Promise<void>
    {
        await this.Put({ id: randomUUID(), hiveId, environments, reportedAt: new Date().toISOString() })
        await this.Trim(hiveId)
    }

    /** Keeps the newest MaxPerHive records of the hive. */
    private async Trim(hiveId: string): Promise<void>
    {
        const ascending = this.AscendingFor(hiveId)
        const excess = ascending.length - HiveObservationRegistry.MaxPerHive
        for (let i = 0; i < excess; i++)
        {
            await this.Remove((ascending[i]!).id)
        }
    }

    /**
     * Records a verified HiveReport: every member is a closed shape (names, enums, versions), so no free text can reach
     * the record. An environment is ready when it reports Ready; its version is kept as the running image.
     */
    public async RecordReport(hiveId: string, report: HiveReport): Promise<void>
    {
        const environments: HiveHealthDto[] = report.Environments.map(environment => ({
            environmentName: environment.Name,
            ready: environment.Readiness === EnvironmentReadiness.Ready,
            runningImage: environment.Version ?? undefined,
            detail: environment.Readiness,
        }))
        await this.Put({
            id: randomUUID(),
            hiveId,
            environments,
            reportedAt: new Date().toISOString(),
            engineVersion: report.EngineVersion,
            components: report.Components.map(entry => ({ component: entry.Component, state: entry.State, version: entry.Version })),
            intents: report.Intents.map(entry => ({ intentId: entry.IntentId, progress: entry.Progress })),
        })
        await this.Trim(hiveId)
    }

    public LatestFor(hiveId: string): HiveHealthDto[]
    {
        return this.LatestRecord(hiveId)?.environments ?? []
    }

    public LatestRecord(hiveId: string): HiveObservationRecord | undefined
    {
        return this.AscendingFor(hiveId).at(-1)
    }

    public HistoryFor(hiveId: string, limit: number): readonly HiveObservationRecord[]
    {
        return this.AscendingFor(hiveId).reverse().slice(0, limit)
    }

    /** This hive's records oldest-first; ties keep insertion order (stable sort). */
    private AscendingFor(hiveId: string): HiveObservationRecord[]
    {
        return [...this.Values()]
            .filter(r => r.hiveId === hiveId)
            .sort((a, b) => a.reportedAt.localeCompare(b.reportedAt))
            .map(r => structuredClone(r))
    }
}
