import type { ReleaseChart } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import type { ManifestRecord, ManifestRelease } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/** A verified release's provenance as this console records it: the shared shape plus, from schema 3 on, the engine chart. */
export type ChartedManifestRelease = ManifestRelease & {
    /** The engine chart the release descriptor signs (schema 3 and later): what a hosted placement installs. */
    chart?: ReleaseChart
    /** Set when the signed descriptor carries no chart (schemas 1 and 2), so it is never looked for again. */
    chartless?: true
}

/**
 * Reading and writing the engine chart (C3.2's `chart`: reference, version and OCI manifest digest) on a verified
 * release record (C5.1): the descriptor signature binds it with the images, and a hosted placement pins it by digest.
 */
export class ReleaseCharts
{
    private static readonly DigestPattern = /^sha256:[a-f0-9]{64}$/

    private constructor()
    {
    }

    /** The record's engine chart, when the release carries one with a well-formed digest. */
    public static Of(record: ManifestRecord): ReleaseChart | undefined
    {
        const chart = (record.release as ChartedManifestRelease | undefined)?.chart
        return chart !== undefined && typeof chart.digest === 'string' && ReleaseCharts.DigestPattern.test(chart.digest) ? chart : undefined
    }

    /** Whether the record was already looked at for a chart: it has one, or its descriptor carries none. */
    public static Known(record: ManifestRecord): boolean
    {
        return ReleaseCharts.Of(record) !== undefined || (record.release as ChartedManifestRelease | undefined)?.chartless === true
    }

    /** The release provenance marked as carrying no chart. */
    public static Chartless(release: ManifestRelease): ChartedManifestRelease
    {
        return { ...release, chartless: true }
    }

    /** The release provenance with the chart set. */
    public static With(release: ManifestRelease, chart: ReleaseChart): ChartedManifestRelease
    {
        return { ...release, chart: { reference: chart.reference, version: chart.version, digest: chart.digest } }
    }
}
