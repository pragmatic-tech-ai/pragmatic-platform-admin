import { ComponentDeclarations, SettingType, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ComponentDescriptorSet, OciRegistryClient, ReleaseApps, ReleaseDescriptorsAbsentError, type IComponentAssetSource, type ReleaseManifestDocument } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ReleaseState, type ManifestRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { IReleaseComponentsArtifact, IReleaseManifestSource, IReleaseRecords } from '../release/release-descriptor-source.js'

/** Small real component descriptors (one option, one setting) per app and version, and the records and sources around them. */
export class ReleaseDescriptorFixtures
{
    public static readonly Version = '0.1.0-early.9'
    public static readonly OlderVersion = '0.1.0-early.7'
    public static readonly Owner = 'pragmatic-tech-ai/'

    /** A real descriptor of `app` at component version `version`; `marker` varies its content (so its digest). */
    public static Descriptor(app: string, version: string = '0.1.0', marker: string = 'a'): ComponentDescriptor
    {
        return ComponentDeclarations.Build({
            name: app,
            version,
            options: [{
                name: 'core',
                description: 'The core settings of ' + app + '.',
                settings: [{ name: 'mode', type: SettingType.String, source: 'PRAGMATIC_TEST_MODE', default: marker, description: 'A test setting.' }],
            }],
            roles: [],
            postgres: false,
            ports: [],
        })
    }

    /** One descriptor per app of a release. */
    public static Set(marker: string = 'a'): ComponentDescriptorSet
    {
        return ComponentDescriptorSet.FromDescriptors(ReleaseApps.All.map(app => ReleaseDescriptorFixtures.Descriptor(app, '0.1.0', marker)))
    }

    /** The bytes a repository release's component.json asset carries: the descriptor's canonical JSON. */
    public static Bytes(descriptor: ComponentDescriptor): Uint8Array
    {
        return new TextEncoder().encode(descriptor.ToCanonicalJson())
    }

    /** A verified catalogue record of `version` whose images sign the given descriptors' digests (none: schema 1). */
    public static Record(version: string, set: ComponentDescriptorSet | undefined, state: ReleaseState = ReleaseState.Verified): ManifestRecord
    {
        const images: NonNullable<NonNullable<ManifestRecord['release']>['images']> = {}
        for (const app of ReleaseApps.All)
        {
            const digest = set?.Get(app)?.ContentDigest()
            images[app] = digest === undefined
                ? { repository: ReleaseDescriptorFixtures.Owner + app, digest: 'sha256:' + '1'.repeat(64) }
                : { repository: ReleaseDescriptorFixtures.Owner + app, digest: 'sha256:' + '1'.repeat(64), componentDigest: digest }
        }
        return {
            id: version, image: 'ghcr.io/pragmatic-tech-ai/pragmatic-env-server@sha256:' + '1'.repeat(64), signed: true, publishedAt: '2026-11-20T00:00:00.000Z',
            release: { state, images },
        }
    }

    /** The release manifest of `version`: every app from its own repository at component version 0.1.0. */
    public static Manifest(version: string): ReleaseManifestDocument
    {
        const components: Record<string, { repository: string; version: string; digest: string }> = {}
        for (const app of ReleaseApps.All)
        {
            components[app] = { repository: ReleaseDescriptorFixtures.Owner + app, version: '0.1.0', digest: 'sha256:' + '1'.repeat(64) }
        }
        return { schema: 1, version, components: components as ReleaseManifestDocument['components'] }
    }

    public static Digest(bytes: Uint8Array): string
    {
        return OciRegistryClient.DigestOf(bytes)
    }
}

/** IReleaseRecords over a fixed list. */
export class FakeReleaseRecords implements IReleaseRecords
{
    public constructor(public readonly Records: ManifestRecord[] = [])
    {
    }

    public AllManifests(): readonly ManifestRecord[]
    {
        return this.Records
    }
}

/** The `components-<version>` artifact per version; a version without one answers ReleaseDescriptorsAbsentError, `Error` throws it. */
export class FakeComponentsArtifact implements IReleaseComponentsArtifact
{
    public readonly Sets = new Map<string, ComponentDescriptorSet>()
    public readonly Asked: string[] = []
    public Error: Error | undefined

    public async Descriptors(version: string): Promise<ComponentDescriptorSet>
    {
        this.Asked.push(version)
        if (this.Error !== undefined)
        {
            throw this.Error
        }
        const set = this.Sets.get(version)
        if (set === undefined)
        {
            throw new ReleaseDescriptorsAbsentError(version)
        }
        return set
    }
}

/** IReleaseManifestSource over a map of versions. */
export class FakeManifestSource implements IReleaseManifestSource
{
    public readonly Manifests = new Map<string, ReleaseManifestDocument>()
    public readonly Asked: string[] = []

    public async ManifestOf(version: string): Promise<ReleaseManifestDocument | undefined>
    {
        this.Asked.push(version)
        return this.Manifests.get(version)
    }
}

/** IComponentAssetSource over a map keyed `<repository>@<version>`. */
export class FakeAssets implements IComponentAssetSource
{
    private static readonly KeySeparator = '@'
    public readonly Assets = new Map<string, Uint8Array>()

    public static Key(repository: string, version: string): string
    {
        return repository + FakeAssets.KeySeparator + version
    }

    /** Every app's asset at 0.1.0, from the set's descriptors. */
    public PutAll(set: ComponentDescriptorSet): void
    {
        for (const descriptor of set.All())
        {
            this.Assets.set(FakeAssets.Key(ReleaseDescriptorFixtures.Owner + descriptor.Name, '0.1.0'), ReleaseDescriptorFixtures.Bytes(descriptor))
        }
    }

    public async ComponentAsset(repository: string, version: string): Promise<Uint8Array | undefined>
    {
        return this.Assets.get(FakeAssets.Key(repository, version))
    }

    public async ReleaseCommit(): Promise<string | undefined>
    {
        return undefined
    }
}
