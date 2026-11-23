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
    public constructor(private readonly releases: IPlatformRelease, private readonly source: IReleaseDescriptorSource)
    {
    }

    /** The release whose descriptors a console install starting now delivers; undefined when its image is not from a release. */
    public ReleaseOfConsole(): string | undefined
    {
        return this.releases.ReleaseOf(ReleaseApp.TenantAdmin)
    }

    /** The ConfigMap manifest of `version`'s descriptors for `hiveId`; undefined when the release carries none it vouches for. */
    public async ManifestFor(version: string, hiveId: string): Promise<string | undefined>
    {
        const set = await this.source.DescriptorsOf(version)
        return set === undefined ? undefined : ReleaseDescriptorsConfigMap.ManifestOf(set, hiveId, version)
    }
}
