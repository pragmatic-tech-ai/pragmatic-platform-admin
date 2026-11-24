import { ComponentDescriptorCodec, ComponentDescriptorError, type ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ComponentAssetUnavailableError, ComponentDescriptorSet, type IComponentAssetSource, OciProtocolError, OciRegistryClient, OciResponseError, OciUnavailableError, ReleaseApp, ReleaseApps, ReleaseDescriptorMismatchError, ReleaseDescriptorsAbsentError, type ReleaseManifestComponent, type ReleaseManifestDocument } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ReleaseState, type ManifestRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { GitHubRateLimit } from './github-rate-limit.js'

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

/** The descriptors of a release cannot be had. The sentence names the release and a fixed reason (plus at most an app) only. */
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
 * The descriptors of a verified, non-withdrawn platform release, from its `components-<version>` artifact (the signature
 * check is the artifact reader's); for a release cut before that artifact existed, from its manifest's component assets:
 * the `component.json` each app's repository release `v<version>` attached, as `release.json` at the release's tag names
 * them. Either way every descriptor must hash to the component digest the catalogue verified for that app at import (the
 * signed descriptor binds it), so neither the artifact nor GitHub is trusted for content. A release's set never changes,
 * so a set read once is kept per version (a reinstall reads neither the registry nor GitHub again); failures are not kept.
 * The fallback reads every app the release signs (the console configures them all): release.json plus, per app, the
 * repository release and its asset, 19 GitHub requests for a nine-app release, once per version and process.
 * Registry and GitHub failures are reported as ReleaseDescriptorsUnavailableError with a fixed sentence.
 */
export class ReleaseDescriptorSource implements IReleaseDescriptorSource
{
    private static readonly NotVerified = 'it is not a verified release in the catalogue'
    private static readonly Withdrawn = 'it is withdrawn'
    private static readonly NoManifest = 'its release manifest was not found'
    private static readonly ManifestVersionMismatch = 'its release manifest names another version'
    private static readonly NoComponentPrefix = 'its release manifest names no component for '
    private static readonly NoAssetPrefix = 'no component.json asset for '
    private static readonly UnreadablePrefix = 'unreadable component descriptor for '
    private static readonly OtherComponentPrefix = 'the descriptor names another component than '
    private static readonly UnsignedPrefix = 'the artifact carries a descriptor the release does not sign: '
    private static readonly RegistryUnreachable = 'the release registry is unreachable'
    private static readonly ArtifactMalformed = 'its components artifact is malformed'
    private static readonly ArtifactUnreadable = 'it carries a component descriptor this platform admin console cannot read (a later console is needed)'
    private static readonly RegistryStatusPrefix = 'the release registry answered HTTP '
    private static readonly GitHubPrefix = 'GitHub could not be asked for the component.json of '
    private static readonly ReasonSeparator = ': '

    private readonly sets = new Map<string, ComponentDescriptorSet>()

    public constructor(
        private readonly records: IReleaseRecords,
        private readonly artifact: IReleaseComponentsArtifact,
        private readonly manifests: IReleaseManifestSource,
        private readonly assets: IComponentAssetSource,
        private readonly gitHubLimit?: GitHubRateLimit,
    )
    {
    }

    public async DescriptorsOf(version: string): Promise<ComponentDescriptorSet | undefined>
    {
        const S = ReleaseDescriptorSource
        const signed = S.SignedDigestsOf(this.records.AllManifests(), version)
        if (signed.size === 0)
        {
            return undefined
        }
        const kept = this.sets.get(version)
        if (kept !== undefined)
        {
            return S.Checked(version, kept.All(), signed)
        }
        const set = await this.Read(version, signed)
        this.sets.set(version, set)
        return set
    }

    private async Read(version: string, signed: ReadonlyMap<ReleaseApp, string>): Promise<ComponentDescriptorSet>
    {
        const S = ReleaseDescriptorSource
        let set: ComponentDescriptorSet
        try
        {
            set = await this.artifact.Descriptors(version)
        }
        catch (error)
        {
            if (error instanceof ReleaseDescriptorsAbsentError)
            {
                return await this.FromManifest(version, signed)
            }
            if (error instanceof OciUnavailableError)
            {
                throw new ReleaseDescriptorsUnavailableError(version, S.RegistryUnreachable)
            }
            if (error instanceof OciProtocolError)
            {
                throw new ReleaseDescriptorsUnavailableError(version, S.ArtifactMalformed)
            }
            if (error instanceof ComponentDescriptorError)
            {
                throw new ReleaseDescriptorsUnavailableError(version, S.ArtifactUnreadable)
            }
            if (error instanceof OciResponseError)
            {
                throw new ReleaseDescriptorsUnavailableError(version, S.RegistryStatusPrefix + String(error.status))
            }
            throw error
        }
        return S.Checked(version, set.All(), signed)
    }

    /**
     * The signed component digest per app of the verified record `version` (empty for schema 1). A version that is not
     * verified, or that the operator withdrew (it is never offered for an install), is refused.
     */
    private static SignedDigestsOf(records: readonly ManifestRecord[], version: string): Map<ReleaseApp, string>
    {
        const S = ReleaseDescriptorSource
        const record = records.find(r => r.id === version && r.release?.state === ReleaseState.Verified)
        if (record === undefined)
        {
            throw new ReleaseDescriptorsUnavailableError(version, S.NotVerified)
        }
        if (record.withdrawn === true)
        {
            throw new ReleaseDescriptorsUnavailableError(version, S.Withdrawn)
        }
        const digests = new Map<ReleaseApp, string>()
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

    private async FromManifest(version: string, signed: ReadonlyMap<ReleaseApp, string>): Promise<ComponentDescriptorSet>
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
            const component: ReleaseManifestComponent | undefined = manifest.components[app]
            if (component === undefined)
            {
                throw new ReleaseDescriptorsUnavailableError(version, S.NoComponentPrefix + app)
            }
            const bytes = await this.AssetOf(version, app, component)
            const actual = OciRegistryClient.DigestOf(bytes)
            if (actual !== digest)
            {
                throw new ReleaseDescriptorMismatchError(app, digest, actual)
            }
            descriptors.push(S.Parsed(version, app, digest, bytes))
        }
        return ComponentDescriptorSet.FromDescriptors(descriptors)
    }

    private async AssetOf(version: string, app: ReleaseApp, component: ReleaseManifestComponent): Promise<Uint8Array>
    {
        const S = ReleaseDescriptorSource
        let bytes: Uint8Array | undefined
        try
        {
            bytes = await this.assets.ComponentAsset(component.repository, component.version)
        }
        catch (error)
        {
            if (error instanceof ComponentAssetUnavailableError)
            {
                // Its message is the asset source's own fixed sentence (never a body or a token); the rate limit is named as such.
                const reason = this.gitHubLimit?.Limited === true ? GitHubRateLimit.Message : error.message
                throw new ReleaseDescriptorsUnavailableError(version, S.GitHubPrefix + app + S.ReasonSeparator + reason)
            }
            throw error
        }
        if (bytes === undefined)
        {
            throw new ReleaseDescriptorsUnavailableError(version, S.NoAssetPrefix + app)
        }
        return bytes
    }

    private static Parsed(version: string, app: ReleaseApp, digest: string, bytes: Uint8Array): ComponentDescriptor
    {
        const S = ReleaseDescriptorSource
        let descriptor: ComponentDescriptor
        try
        {
            descriptor = ComponentDescriptorCodec.Parse(new TextDecoder().decode(bytes))
        }
        catch
        {
            throw new ReleaseDescriptorsUnavailableError(version, S.UnreadablePrefix + app)
        }
        if (descriptor.Name !== app)
        {
            throw new ReleaseDescriptorsUnavailableError(version, S.OtherComponentPrefix + app)
        }
        if (descriptor.ContentDigest() !== digest)
        {
            throw new ReleaseDescriptorMismatchError(app, digest, descriptor.ContentDigest())
        }
        return descriptor
    }

    /** Exactly the signed apps, each at its signed digest (the artifact reader checked the same against the signature). */
    private static Checked(version: string, descriptors: readonly ComponentDescriptor[], signed: ReadonlyMap<ReleaseApp, string>): ComponentDescriptorSet
    {
        const S = ReleaseDescriptorSource
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
            const app = ReleaseApps.All.find(candidate => candidate === name)
            if (app === undefined || !signed.has(app))
            {
                throw new ReleaseDescriptorsUnavailableError(version, S.UnsignedPrefix + name)
            }
        }
        return ComponentDescriptorSet.FromDescriptors(descriptors)
    }
}
