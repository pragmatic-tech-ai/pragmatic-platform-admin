import { ComponentDeclarations, SettingType, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ComponentDescriptorSet, OciRegistryClient, ReleaseApp, ReleaseApps, ReleaseDescriptorsAbsentError, type IComponentAssetSource, type ReleaseManifestComponent, type ReleaseManifestDocument } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ReleaseState, type ManifestRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { IReleaseComponentsArtifact, IReleaseManifestSource, IReleaseRecords } from '../release/release-descriptor-source.js'

/** Small real component descriptors (one option, one setting) per app and version, and the records and sources around them. */
export class ReleaseDescriptorFixtures
{
    public static readonly Version = '0.1.0-early.9'
    public static readonly OlderVersion = '0.1.0-early.7'
    public static readonly Owner = 'pragmatic-tech-ai/'
    /** The component version every fake app's repository release carries. */
    public static readonly ComponentVersion = '0.1.0'
    public static readonly ImageDigest = 'sha256:' + '1'.repeat(64)
    public static readonly ServerImage = 'ghcr.io/pragmatic-tech-ai/pragmatic-env-server@' + ReleaseDescriptorFixtures.ImageDigest
    public static readonly PublishedAt = '2026-11-20T00:00:00.000Z'
    /** Content markers: each yields descriptors with their own digests. */
    public static readonly Marker = 'a'
    public static readonly PreArtifactMarker = 'pre'
    public static readonly OlderMarker = 'older'
    public static readonly NewerMarker = 'newer'
    public static readonly ForgedMarker = 'forged'
    public static readonly TamperedMarker = 'tampered'
    /** A component no release carries. */
    public static readonly Stranger = 'pragmatic-stranger'
    private static readonly OptionName = 'core'
    private static readonly OptionDescriptionPrefix = 'The core settings of '
    private static readonly Dot = '.'
    private static readonly SettingName = 'mode'
    private static readonly SettingSource = 'PRAGMATIC_TEST_MODE'
    private static readonly SettingDescription = 'A test setting.'

    /** A real descriptor of `app` at component version `version`; `marker` varies its content (so its digest). */
    public static Descriptor(app: string, version: string = ReleaseDescriptorFixtures.ComponentVersion, marker: string = ReleaseDescriptorFixtures.Marker): ComponentDescriptor
    {
        const F = ReleaseDescriptorFixtures
        return ComponentDeclarations.Build({
            name: app,
            version,
            options: [{
                name: F.OptionName,
                description: F.OptionDescriptionPrefix + app + F.Dot,
                settings: [{ name: F.SettingName, type: SettingType.String, source: F.SettingSource, default: marker, description: F.SettingDescription }],
            }],
            roles: [],
            postgres: false,
            ports: [],
        })
    }

    /** One descriptor per app of a release. */
    public static Set(marker: string = ReleaseDescriptorFixtures.Marker): ComponentDescriptorSet
    {
        return ComponentDescriptorSet.FromDescriptors(ReleaseApps.All.map(app => ReleaseDescriptorFixtures.Descriptor(app, ReleaseDescriptorFixtures.ComponentVersion, marker)))
    }

    /** The bytes a repository release's component.json asset carries: the descriptor's canonical JSON. */
    public static Bytes(descriptor: ComponentDescriptor): Uint8Array
    {
        return new TextEncoder().encode(descriptor.ToCanonicalJson())
    }

    /** A catalogue record of `version` whose images sign the given descriptors' digests (none: schema 1). */
    public static Record(version: string, set: ComponentDescriptorSet | undefined, state: ReleaseState = ReleaseState.Verified, withdrawn: boolean = false): ManifestRecord
    {
        const F = ReleaseDescriptorFixtures
        const images: NonNullable<NonNullable<ManifestRecord['release']>['images']> = {}
        for (const app of ReleaseApps.All)
        {
            const digest = set?.Get(app)?.ContentDigest()
            images[app] = digest === undefined
                ? { repository: F.Owner + app, digest: F.ImageDigest }
                : { repository: F.Owner + app, digest: F.ImageDigest, componentDigest: digest }
        }
        const record: ManifestRecord = { id: version, image: F.ServerImage, signed: true, publishedAt: F.PublishedAt, release: { state, images } }
        if (withdrawn)
        {
            record.withdrawn = true
        }
        return record
    }

    /** The release manifest of `version`: every app from its own repository at the fixtures' component version. */
    public static Manifest(version: string): ReleaseManifestDocument
    {
        const F = ReleaseDescriptorFixtures
        const of = (app: ReleaseApp): ReleaseManifestComponent => ({ repository: F.Owner + app, version: F.ComponentVersion, digest: F.ImageDigest })
        const components: Record<ReleaseApp, ReleaseManifestComponent> = {
            [ReleaseApp.PlatformAdmin]: of(ReleaseApp.PlatformAdmin),
            [ReleaseApp.PlatformEdge]: of(ReleaseApp.PlatformEdge),
            [ReleaseApp.EnvServer]: of(ReleaseApp.EnvServer),
            [ReleaseApp.EnvGateway]: of(ReleaseApp.EnvGateway),
            [ReleaseApp.HiveAgent]: of(ReleaseApp.HiveAgent),
            [ReleaseApp.TenantAdmin]: of(ReleaseApp.TenantAdmin),
            [ReleaseApp.TenantIdp]: of(ReleaseApp.TenantIdp),
            [ReleaseApp.UiUnpack]: of(ReleaseApp.UiUnpack),
            [ReleaseApp.Postgres]: of(ReleaseApp.Postgres),
            [ReleaseApp.HostAgent]: of(ReleaseApp.HostAgent),
        }
        return { schema: 1, version, components }
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

/** IComponentAssetSource over a map keyed `<repository>@<version>`; `Error` makes every read throw it. */
export class FakeAssets implements IComponentAssetSource
{
    private static readonly KeySeparator = '@'
    public readonly Assets = new Map<string, Uint8Array>()
    public readonly Asked: string[] = []
    public Error: Error | undefined

    public static Key(repository: string, version: string = ReleaseDescriptorFixtures.ComponentVersion): string
    {
        return repository + FakeAssets.KeySeparator + version
    }

    /** Every app's asset at the fixtures' component version, from the set's descriptors. */
    public PutAll(set: ComponentDescriptorSet): void
    {
        for (const descriptor of set.All())
        {
            this.Assets.set(FakeAssets.Key(ReleaseDescriptorFixtures.Owner + descriptor.Name), ReleaseDescriptorFixtures.Bytes(descriptor))
        }
    }

    public async ComponentAsset(repository: string, version: string): Promise<Uint8Array | undefined>
    {
        this.Asked.push(FakeAssets.Key(repository, version))
        if (this.Error !== undefined)
        {
            throw this.Error
        }
        return this.Assets.get(FakeAssets.Key(repository, version))
    }

    public async ReleaseCommit(): Promise<string | undefined>
    {
        return undefined
    }
}
