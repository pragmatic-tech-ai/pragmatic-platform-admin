import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import type { IPlatformRelease } from './platform-images.js'
import type { IReleaseDescriptorSource } from './release/release-descriptor-source.js'
import { ReleaseDescriptorsConfigMap } from './release-descriptors-config-map.js'

/**
 * Delivers a release's component descriptors to a hive's tenant console: the release is the one the console's
 * tenant-admin image comes from (read when the install starts, beside the images, so both name one release), and the
 * object written is ReleaseDescriptorsConfigMap. No release (a development box), or a release that signs no component
 * digests, means nothing to deliver.
 */
export class ConsoleReleaseDescriptors
{
    /** The apps one console install runs (TenantConsoleInstaller). */
    public static readonly ConsoleApps: readonly ReleaseApp[] = [ReleaseApp.TenantAdmin, ReleaseApp.TenantIdp, ReleaseApp.Postgres]

    public constructor(private readonly releases: IPlatformRelease, private readonly source: IReleaseDescriptorSource)
    {
    }

    /** The release whose descriptors a console install starting now delivers; undefined when its image is not from a release. */
    public ReleaseOfConsole(): string | undefined
    {
        return this.releases.ReleaseOf(ReleaseApp.TenantAdmin)
    }

    /** Whether `app`'s offered image comes from the release whose descriptors the console install delivers (the hive agent
     *  is rolled with the console only then: its configuration is prepared for that release's descriptor). */
    public SameRelease(app: ReleaseApp): boolean
    {
        return this.releases.ReleaseOf(app) === this.ReleaseOfConsole()
    }

    /**
     * Whether the console's images (tenant-admin, the IdP, pragmatic-postgres) come from different releases (the newest
     * release per app differs when the newest one lacks an app): then no one release's descriptors describe what runs.
     */
    public IsMixed(): boolean
    {
        return new Set(ConsoleReleaseDescriptors.ConsoleApps.map(app => this.releases.ReleaseOf(app))).size > 1
    }

    /** The ConfigMap manifest of `version`'s descriptors for `hiveId`; undefined when the release carries none it vouches for. */
    public async ManifestFor(version: string, hiveId: string): Promise<string | undefined>
    {
        const set = await this.source.DescriptorsOf(version)
        return set === undefined ? undefined : ReleaseDescriptorsConfigMap.ManifestOf(set, hiveId, version)
    }
}
