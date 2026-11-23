import { ComponentDescriptorCodec, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ComponentDescriptorSet, type IComponentAssetSource, OciRegistryClient, ReleaseApps, ReleaseDescriptorMismatchError, ReleaseDescriptorsAbsentError, type ReleaseManifestDocument } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ReleaseState, type ManifestRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/** The component descriptors of one platform release, each bound by the digest the release's signature covers. */
export interface IReleaseDescriptorSource
{
    /**
     * The descriptors of the verified release `version`; undefined when the release signs no component digests (schema 1),
     * so there is nothing it vouches for. Throws when they cannot be had or do not match what the release signs.
     */
    DescriptorsOf(version: string): Promise<ComponentDescriptorSet | undefined>
}

/** Reads a release's `components-<version>` artifact (ReleaseComponentDescriptors); ReleaseDescriptorsAbsentError before it existed. */
export interface IReleaseComponentsArtifact
{
    Descriptors(version: string): Promise<ComponentDescriptorSet>
}

/** `release.json` of the platform release `version` (pragmatic-platform-release at its tag); undefined when there is none. */
export interface IReleaseManifestSource
{
    ManifestOf(version: string): Promise<ReleaseManifestDocument | undefined>
}

/** The release records the catalogue imported (PlatformDeploymentRegistry.AllManifests). */
export interface IReleaseRecords
{
    AllManifests(): readonly ManifestRecord[]
}

/** The descriptors of a release cannot be had. The sentence names the release and the reason only. */
export class ReleaseDescriptorsUnavailableError extends Error
{
    private static readonly ErrorName = 'ReleaseDescriptorsUnavailableError'
    private static readonly Prefix = 'The component descriptors of release '
    private static readonly Infix = ' are unavailable: '

    public constructor(public readonly Version: string, public readonly Reason: string)
    {
        super(ReleaseDescriptorsUnavailableError.Prefix + Version + ReleaseDescriptorsUnavailableError.Infix + Reason)
        this.name = ReleaseDescriptorsUnavailableError.ErrorName
    }
}

/**
 * The descriptors of a verified platform release, from its `components-<version>` artifact (the signature check is the
 * artifact reader's); for a release cut before that artifact existed, from its manifest's component assets: the
 * `component.json` each app's repository release `v<version>` attached, as `release.json` at the release's tag names them.
 * Either way every descriptor must hash to the component digest the catalogue verified for that app at import (the
 * signed descriptor binds it), so neither the artifact nor GitHub is trusted for content.
 */
export class ReleaseDescriptorSource implements IReleaseDescriptorSource
{
    private static readonly NotVerified = 'it is not a verified release in the catalogue'
    private static readonly NoManifest = 'its release manifest was not found'
    private static readonly ManifestVersionMismatch = 'its release manifest names another version'
    private static readonly NoComponentPrefix = 'its release manifest names no component for '
    private static readonly NoAssetPrefix = 'no component.json asset for '
    private static readonly UnreadablePrefix = 'unreadable component descriptor for '
    private static readonly UnsignedPrefix = 'the artifact carries a descriptor the release does not sign: '

    public constructor(
        private readonly records: IReleaseRecords,
        private readonly artifact: IReleaseComponentsArtifact,
        private readonly manifests: IReleaseManifestSource,
        private readonly assets: IComponentAssetSource,
    )
    {
    }

    public async DescriptorsOf(version: string): Promise<ComponentDescriptorSet | undefined>
    {
        const S = ReleaseDescriptorSource
        const signed = S.SignedDigestsOf(this.records.AllManifests(), version)
        if (signed === undefined)
        {
            throw new ReleaseDescriptorsUnavailableError(version, S.NotVerified)
        }
        if (signed.size === 0)
        {
            return undefined
        }
        let set: ComponentDescriptorSet
        try
        {
            set = await this.artifact.Descriptors(version)
        }
        catch (error)
        {
            if (!(error instanceof ReleaseDescriptorsAbsentError))
            {
                throw error
            }
            return await this.FromManifest(version, signed)
        }
        return S.Checked(version, set.All(), signed)
    }

    /** The signed component digest per app of the verified, non-rejected record `version`; undefined when there is none. */
    private static SignedDigestsOf(records: readonly ManifestRecord[], version: string): Map<string, string> | undefined
    {
        const record = records.find(r => r.id === version && r.release?.state === ReleaseState.Verified)
        if (record === undefined)
        {
            return undefined
        }
        const digests = new Map<string, string>()
        for (const app of ReleaseApps.All)
        {
            const digest = record.release?.images?.[app]?.componentDigest
            if (digest !== undefined)
            {
                digests.set(app, digest)
            }
        }
        return digests
    }

    private async FromManifest(version: string, signed: ReadonlyMap<string, string>): Promise<ComponentDescriptorSet>
    {
        const S = ReleaseDescriptorSource
        const manifest = await this.manifests.ManifestOf(version)
        if (manifest === undefined)
        {
            throw new ReleaseDescriptorsUnavailableError(version, S.NoManifest)
        }
        if (manifest.version !== version)
        {
            throw new ReleaseDescriptorsUnavailableError(version, S.ManifestVersionMismatch)
        }
        const descriptors: ComponentDescriptor[] = []
        for (const [app, digest] of signed)
        {
            const component = (manifest.components as Readonly<Record<string, { repository: string; version: string } | undefined>>)[app]
            if (component === undefined)
            {
                throw new ReleaseDescriptorsUnavailableError(version, S.NoComponentPrefix + app)
            }
            const bytes = await this.assets.ComponentAsset(component.repository, component.version)
            if (bytes === undefined)
            {
                throw new ReleaseDescriptorsUnavailableError(version, S.NoAssetPrefix + app)
            }
            const actual = OciRegistryClient.DigestOf(bytes)
            if (actual !== digest)
            {
                throw new ReleaseDescriptorMismatchError(app, digest, actual)
            }
            descriptors.push(S.Parsed(version, app, digest, bytes))
        }
        return ComponentDescriptorSet.FromDescriptors(descriptors)
    }

    private static Parsed(version: string, app: string, digest: string, bytes: Uint8Array): ComponentDescriptor
    {
        let descriptor: ComponentDescriptor
        try
        {
            descriptor = ComponentDescriptorCodec.Parse(new TextDecoder().decode(bytes))
        }
        catch
        {
            throw new ReleaseDescriptorsUnavailableError(version, ReleaseDescriptorSource.UnreadablePrefix + app)
        }
        if (descriptor.Name !== app || descriptor.ContentDigest() !== digest)
        {
            throw new ReleaseDescriptorMismatchError(app, digest, descriptor.ContentDigest())
        }
        return descriptor
    }

    /** Exactly the signed apps, each at its signed digest (the artifact reader checked the same against the signature). */
    private static Checked(version: string, descriptors: readonly ComponentDescriptor[], signed: ReadonlyMap<string, string>): ComponentDescriptorSet
    {
        const byName = new Map(descriptors.map(d => [d.Name, d]))
        for (const [app, digest] of signed)
        {
            const actual = byName.get(app)?.ContentDigest()
            if (actual !== digest)
            {
                throw new ReleaseDescriptorMismatchError(app, digest, actual)
            }
        }
        for (const name of byName.keys())
        {
            if (!signed.has(name))
            {
                throw new ReleaseDescriptorsUnavailableError(version, ReleaseDescriptorSource.UnsignedPrefix + name)
            }
        }
        return ComponentDescriptorSet.FromDescriptors(descriptors)
    }
}
