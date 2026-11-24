import { ComponentDescriptorError } from '@pragmatic-tech-ai/pragmatic-component'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ComponentAssetUnavailableError, ComponentDescriptorSet, OciResponseError, OciUnavailableError, ReleaseApp, ReleaseApps, ReleaseDescriptorMismatchError } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ReleaseState } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ReleaseDescriptorSource, ReleaseDescriptorsUnavailableError } from '../release-descriptor-source.js'
import { GitHubRateLimit } from '../github-rate-limit.js'
import { FakeAssets, FakeComponentsArtifact, FakeManifestSource, FakeReleaseRecords, ReleaseDescriptorFixtures as F } from '../../tests/release-descriptor-fixtures.js'

class SourceFixture
{
    public static readonly RegistryDown = 'registry unreachable'
    public static readonly GitHubDown = 'GitHub is unreachable'
    public static readonly StatusForbidden = 403
    public static readonly StatusForbiddenText = 'denied'
    public static readonly StatusTooMany = 429
    public static readonly WithdrawnPattern = /withdrawn/
    public static readonly NoManifestPattern = /manifest was not found/
    public static readonly OtherVersionPattern = /another version/
    public static readonly UnreachablePattern = /the release registry is unreachable$/
    public static readonly ForbiddenPattern = /the release registry answered HTTP 403$/
    public static readonly NotVerifiedPattern = /not a verified release/
    public static readonly TooManyText = 'GitHub answered HTTP 429'
    public static readonly AnyUrl = 'https://api.github.com/'
    public static readonly Get = 'GET'
    public static readonly Manual = 'manual'

    public readonly Records = new FakeReleaseRecords()
    public readonly Artifact = new FakeComponentsArtifact()
    public readonly Manifests = new FakeManifestSource()
    public readonly Assets = new FakeAssets()
    public readonly Source = new ReleaseDescriptorSource(this.Records, this.Artifact, this.Manifests, this.Assets)

    /** A release with its components artifact. */
    public static WithArtifact(version: string = F.Version): { fx: SourceFixture; set: ComponentDescriptorSet }
    {
        const fx = new SourceFixture()
        const set = F.Set()
        fx.Records.Records.push(F.Record(version, set))
        fx.Artifact.Sets.set(version, set)
        return { fx, set }
    }

    /** A release cut before the artifact: its manifest and its repositories' component.json assets only. */
    public static PreArtifact(version: string = F.OlderVersion): { fx: SourceFixture; set: ComponentDescriptorSet }
    {
        const fx = new SourceFixture()
        const set = F.Set(F.PreArtifactMarker)
        fx.Records.Records.push(F.Record(version, set))
        fx.Manifests.Manifests.set(version, F.Manifest(version))
        fx.Assets.PutAll(set)
        return { fx, set }
    }

    public static Digests(set: ComponentDescriptorSet | undefined): Record<string, string>
    {
        return Object.fromEntries((set?.All() ?? []).map(d => [d.Name, d.ContentDigest()]))
    }

    public static Unavailable(pattern: RegExp): (err: unknown) => boolean
    {
        return (err: unknown) => err instanceof ReleaseDescriptorsUnavailableError && pattern.test(err.message)
    }
}

describe('ReleaseDescriptorSource', () =>
{
    it('answers the release\'s components artifact, every descriptor at the digest the catalogue verified', async () =>
    {
        const { fx, set } = SourceFixture.WithArtifact()
        const got = await fx.Source.DescriptorsOf(F.Version)
        assert.deepEqual(SourceFixture.Digests(got), SourceFixture.Digests(set))
        assert.deepEqual(got?.All().map(d => d.Name).sort(), [...ReleaseApps.All].sort())
        assert.deepEqual(fx.Manifests.Asked, [])
    })

    it('keeps a set it read per version: a reinstall reads neither the registry nor GitHub again; a failed read is not kept', async () =>
    {
        const { fx } = SourceFixture.WithArtifact()
        fx.Artifact.Error = new OciUnavailableError(SourceFixture.RegistryDown)
        await assert.rejects(fx.Source.DescriptorsOf(F.Version), ReleaseDescriptorsUnavailableError)
        fx.Artifact.Error = undefined
        await fx.Source.DescriptorsOf(F.Version)
        await fx.Source.DescriptorsOf(F.Version)
        assert.deepEqual(fx.Artifact.Asked, [F.Version, F.Version])
        const pre = SourceFixture.PreArtifact()
        await pre.fx.Source.DescriptorsOf(F.OlderVersion)
        await pre.fx.Source.DescriptorsOf(F.OlderVersion)
        assert.deepEqual(pre.fx.Manifests.Asked, [F.OlderVersion])
        assert.equal(pre.fx.Assets.Asked.length, ReleaseApps.All.length)
    })

    it('a kept set is still checked against the record: a withdrawn release is refused', async () =>
    {
        const { fx, set } = SourceFixture.WithArtifact()
        await fx.Source.DescriptorsOf(F.Version)
        fx.Records.Records.splice(0, 1, F.Record(F.Version, set, ReleaseState.Verified, true))
        await assert.rejects(fx.Source.DescriptorsOf(F.Version), SourceFixture.Unavailable(SourceFixture.WithdrawnPattern))
    })

    it('refuses an artifact descriptor whose digest is not the one the catalogue verified, naming the app', async () =>
    {
        const { fx } = SourceFixture.WithArtifact()
        const swapped = ComponentDescriptorSet.FromDescriptors(F.Set().All().map(d => d.Name === ReleaseApp.TenantIdp ? F.Descriptor(d.Name, F.ComponentVersion, F.ForgedMarker) : d))
        fx.Artifact.Sets.set(F.Version, swapped)
        await assert.rejects(fx.Source.DescriptorsOf(F.Version), (err: unknown) => err instanceof ReleaseDescriptorMismatchError && err.App === ReleaseApp.TenantIdp)
    })

    it('refuses an artifact that carries a descriptor the release does not sign', async () =>
    {
        const { fx, set } = SourceFixture.WithArtifact()
        fx.Artifact.Sets.set(F.Version, ComponentDescriptorSet.FromDescriptors([...set.All(), F.Descriptor(F.Stranger)]))
        await assert.rejects(fx.Source.DescriptorsOf(F.Version), (err: unknown) => err instanceof ReleaseDescriptorsUnavailableError && err.message.includes(F.Stranger))
    })

    it('a release cut before the artifact: the component.json assets its manifest names, each at its signed digest', async () =>
    {
        const { fx, set } = SourceFixture.PreArtifact()
        const got = await fx.Source.DescriptorsOf(F.OlderVersion)
        assert.deepEqual(SourceFixture.Digests(got), SourceFixture.Digests(set))
        assert.deepEqual(fx.Artifact.Asked, [F.OlderVersion])
        assert.deepEqual(fx.Manifests.Asked, [F.OlderVersion])
    })

    it('a pre-artifact asset that is not the signed descriptor is refused, naming the app and both digests', async () =>
    {
        const { fx, set } = SourceFixture.PreArtifact()
        const tampered = F.Bytes(F.Descriptor(ReleaseApp.TenantIdp, F.ComponentVersion, F.TamperedMarker))
        fx.Assets.Assets.set(FakeAssets.Key(F.Owner + ReleaseApp.TenantIdp), tampered)
        await assert.rejects(fx.Source.DescriptorsOf(F.OlderVersion), (err: unknown) => err instanceof ReleaseDescriptorMismatchError
            && err.App === ReleaseApp.TenantIdp && err.Signed === set.Get(ReleaseApp.TenantIdp)?.ContentDigest() && err.Actual === F.Digest(tampered))
    })

    it('a pre-artifact asset that is another component\'s descriptor, even one the release signs for it, is refused', async () =>
    {
        const fx = new SourceFixture()
        const set = F.Set(F.PreArtifactMarker)
        // The release signs, for the IdP, the digest of what is really the hive agent's descriptor.
        const agent = set.Get(ReleaseApp.HiveAgent)
        assert.ok(agent !== undefined)
        const record = F.Record(F.OlderVersion, set)
        const images = record.release?.images
        assert.ok(images !== undefined)
        images[ReleaseApp.TenantIdp] = { repository: F.Owner + ReleaseApp.TenantIdp, digest: F.ImageDigest, componentDigest: agent.ContentDigest() }
        fx.Records.Records.push(record)
        fx.Manifests.Manifests.set(F.OlderVersion, F.Manifest(F.OlderVersion))
        fx.Assets.PutAll(set)
        fx.Assets.Assets.set(FakeAssets.Key(F.Owner + ReleaseApp.TenantIdp), F.Bytes(agent))
        await assert.rejects(fx.Source.DescriptorsOf(F.OlderVersion), SourceFixture.Unavailable(new RegExp('names another component than ' + ReleaseApp.TenantIdp)))
    })

    it('a pre-artifact release without its manifest, with a manifest of another version, or without an app\'s asset is unavailable', async () =>
    {
        const none = SourceFixture.PreArtifact()
        none.fx.Manifests.Manifests.clear()
        await assert.rejects(none.fx.Source.DescriptorsOf(F.OlderVersion), SourceFixture.Unavailable(SourceFixture.NoManifestPattern))
        const other = SourceFixture.PreArtifact()
        other.fx.Manifests.Manifests.set(F.OlderVersion, F.Manifest(F.Version))
        await assert.rejects(other.fx.Source.DescriptorsOf(F.OlderVersion), SourceFixture.Unavailable(SourceFixture.OtherVersionPattern))
        const missing = SourceFixture.PreArtifact()
        missing.fx.Assets.Assets.delete(FakeAssets.Key(F.Owner + ReleaseApp.HiveAgent))
        await assert.rejects(missing.fx.Source.DescriptorsOf(F.OlderVersion), SourceFixture.Unavailable(new RegExp(ReleaseApp.HiveAgent)))
    })

    it('GitHub that cannot be asked for an asset is unavailable with its fixed sentence and the app', async () =>
    {
        const { fx } = SourceFixture.PreArtifact()
        fx.Assets.Error = new ComponentAssetUnavailableError(SourceFixture.GitHubDown)
        await assert.rejects(fx.Source.DescriptorsOf(F.OlderVersion), SourceFixture.Unavailable(new RegExp('component.json of ' + ReleaseApps.All[0] + ': ' + SourceFixture.GitHubDown)))
    })

    it('an asset read that met the rate limit of GitHub is named as such', async () =>
    {
        const { fx } = SourceFixture.PreArtifact()
        const limit = new GitHubRateLimit()
        await limit.Watch(async () => new Response('{}', { status: SourceFixture.StatusTooMany }))(SourceFixture.AnyUrl, { method: SourceFixture.Get, headers: {}, redirect: SourceFixture.Manual })
        const source = new ReleaseDescriptorSource(fx.Records, fx.Artifact, fx.Manifests, fx.Assets, limit)
        fx.Assets.Error = new ComponentAssetUnavailableError(SourceFixture.TooManyText)
        await assert.rejects(source.DescriptorsOf(F.OlderVersion), (err: unknown) => err instanceof ReleaseDescriptorsUnavailableError && err.message.endsWith(': ' + GitHubRateLimit.Message))
    })

    it('a schema-1 release (no signed component digests) has nothing to deliver', async () =>
    {
        const fx = new SourceFixture()
        fx.Records.Records.push(F.Record(F.OlderVersion, undefined))
        assert.equal(await fx.Source.DescriptorsOf(F.OlderVersion), undefined)
        assert.deepEqual(fx.Artifact.Asked, [])
    })

    it('a version the catalogue has not verified, or one withdrawn, is unavailable, whatever the registry holds', async () =>
    {
        const fx = new SourceFixture()
        fx.Artifact.Sets.set(F.Version, F.Set())
        await assert.rejects(fx.Source.DescriptorsOf(F.Version), SourceFixture.Unavailable(SourceFixture.NotVerifiedPattern))
        fx.Records.Records.push(F.Record(F.Version, F.Set(), ReleaseState.Rejected))
        await assert.rejects(fx.Source.DescriptorsOf(F.Version), SourceFixture.Unavailable(SourceFixture.NotVerifiedPattern))
        fx.Records.Records.splice(0, 1, F.Record(F.Version, F.Set(), ReleaseState.Verified, true))
        await assert.rejects(fx.Source.DescriptorsOf(F.Version), SourceFixture.Unavailable(SourceFixture.WithdrawnPattern))
        assert.deepEqual(fx.Artifact.Asked, [])
    })

    it('a registry that cannot be reached, or answers a status, is unavailable with a fixed sentence; it never falls back to GitHub', async () =>
    {
        const { fx } = SourceFixture.WithArtifact()
        fx.Artifact.Error = new OciUnavailableError(SourceFixture.RegistryDown)
        await assert.rejects(fx.Source.DescriptorsOf(F.Version), SourceFixture.Unavailable(SourceFixture.UnreachablePattern))
        fx.Artifact.Error = new OciResponseError(SourceFixture.StatusForbidden, SourceFixture.StatusForbiddenText)
        await assert.rejects(fx.Source.DescriptorsOf(F.Version), SourceFixture.Unavailable(SourceFixture.ForbiddenPattern))
        assert.deepEqual(fx.Manifests.Asked, [])
    })

    it('an artifact carrying a descriptor this console cannot decode (a later descriptor member) is unavailable with its own sentence (review I3)', async () =>
    {
        const { fx } = SourceFixture.WithArtifact()
        fx.Artifact.Error = new ComponentDescriptorError("unknown key 'minimum' in descriptor member 'settings'")
        await assert.rejects(fx.Source.DescriptorsOf(F.Version), SourceFixture.Unavailable(/cannot read \(a later console is needed\)$/))
    })
})
