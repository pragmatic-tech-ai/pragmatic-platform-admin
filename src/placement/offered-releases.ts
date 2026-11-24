import type { ManifestRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ReleaseCharts } from '../release/release-charts.js'

/** The engine a hosted placement installs: the platform release version and its engine chart's digest. */
export type OfferedRelease = { Version: string; ChartDigest: string }

/** What release the platform currently offers a tenant's hosted hive. */
export interface IOfferedReleases
{
    OfferedFor(tenantId: string): OfferedRelease | undefined
}

/** The catalogue's records (PlatformDeploymentRegistry). */
export interface IReleaseCatalogueRecords
{
    InstallReleaseFor(tenantId: string): string | undefined
    AllManifests(): readonly ManifestRecord[]
}

/**
 * The release the platform offers a tenant (C5.1): the one its install command names (the newest verified release
 * the tenant's release policy admits, PlatformDeploymentRegistry.InstallReleaseFor), with the digest of the engine
 * chart its signed descriptor carries. None while that release carries no chart (a release before schema 3): the
 * placement waits for one.
 */
export class CatalogueOfferedReleases implements IOfferedReleases
{
    public constructor(private readonly catalogue: IReleaseCatalogueRecords)
    {
    }

    public OfferedFor(tenantId: string): OfferedRelease | undefined
    {
        const version = this.catalogue.InstallReleaseFor(tenantId)
        const record = version === undefined ? undefined : this.catalogue.AllManifests().find(manifest => manifest.id === version)
        const chart = record === undefined ? undefined : ReleaseCharts.Of(record)
        return version === undefined || chart === undefined || chart.version !== version ? undefined : { Version: version, ChartDigest: chart.digest }
    }
}
