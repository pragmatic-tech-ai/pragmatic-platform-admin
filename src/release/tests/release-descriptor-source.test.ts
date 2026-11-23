import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OciUnavailableError, ReleaseApp, ReleaseApps, ReleaseDescriptorMismatchError } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ComponentDescriptorSet } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ReleaseState } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ReleaseDescriptorSource, ReleaseDescriptorsUnavailableError } from '../release-descriptor-source.js'
import { FakeAssets, FakeComponentsArtifact, FakeManifestSource, FakeReleaseRecords, ReleaseDescriptorFixtures as F } from '../../tests/release-descriptor-fixtures.js'

class SourceFixture
{
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
        const set = F.Set('pre')
        fx.Records.Records.push(F.Record(version, set))
        fx.Manifests.Manifests.set(version, F.Manifest(version))
        fx.Assets.PutAll(set)
        return { fx, set }
    }

    public static Digests(set: ComponentDescriptorSet | undefined): Record<string, string>
    {
        return Object.fromEntries((set?.All() ?? []).map(d => [d.Name, d.ContentDigest()]))
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

    it('refuses an artifact descriptor whose digest is not the one the catalogue verified, naming the app', async () =>
    {
        const { fx } = SourceFixture.WithArtifact()
        const swapped = ComponentDescriptorSet.FromDescriptors(F.Set().All().map(d => d.Name === ReleaseApp.TenantIdp ? F.Descriptor(d.Name, '0.1.0', 'other') : d))
        fx.Artifact.Sets.set(F.Version, swapped)
        await assert.rejects(fx.Source.DescriptorsOf(F.Version), (err: unknown) => err instanceof ReleaseDescriptorMismatchError && err.App === ReleaseApp.TenantIdp)
    })

    it('refuses an artifact that carries a descriptor the release does not sign', async () =>
    {
        const { fx, set } = SourceFixture.WithArtifact()
        fx.Artifact.Sets.set(F.Version, ComponentDescriptorSet.FromDescriptors([...set.All(), F.Descriptor('pragmatic-stranger')]))
        await assert.rejects(fx.Source.DescriptorsOf(F.Version), (err: unknown) => err instanceof ReleaseDescriptorsUnavailableError && err.message.includes('pragmatic-stranger'))
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
        const tampered = F.Bytes(F.Descriptor(ReleaseApp.TenantIdp, '0.1.0', 'tampered'))
        fx.Assets.Assets.set(FakeAssets.Key(F.Owner + ReleaseApp.TenantIdp, '0.1.0'), tampered)
        await assert.rejects(fx.Source.DescriptorsOf(F.OlderVersion), (err: unknown) => err instanceof ReleaseDescriptorMismatchError
            && err.App === ReleaseApp.TenantIdp && err.Signed === set.Get(ReleaseApp.TenantIdp)?.ContentDigest() && err.Actual === F.Digest(tampered))
    })

    it('a pre-artifact release without its manifest, with a manifest of another version, or without an app\'s asset is unavailable', async () =>
    {
        const none = SourceFixture.PreArtifact()
        none.fx.Manifests.Manifests.clear()
        await assert.rejects(none.fx.Source.DescriptorsOf(F.OlderVersion), (err: unknown) => err instanceof ReleaseDescriptorsUnavailableError && /manifest was not found/.test(err.message))
        const other = SourceFixture.PreArtifact()
        other.fx.Manifests.Manifests.set(F.OlderVersion, F.Manifest(F.Version))
        await assert.rejects(other.fx.Source.DescriptorsOf(F.OlderVersion), (err: unknown) => err instanceof ReleaseDescriptorsUnavailableError && /another version/.test(err.message))
        const missing = SourceFixture.PreArtifact()
        missing.fx.Assets.Assets.delete(FakeAssets.Key(F.Owner + ReleaseApp.HiveAgent, '0.1.0'))
        await assert.rejects(missing.fx.Source.DescriptorsOf(F.OlderVersion), (err: unknown) => err instanceof ReleaseDescriptorsUnavailableError && err.message.includes(ReleaseApp.HiveAgent))
    })

    it('a schema-1 release (no signed component digests) has nothing to deliver', async () =>
    {
        const fx = new SourceFixture()
        fx.Records.Records.push(F.Record(F.OlderVersion, undefined))
        assert.equal(await fx.Source.DescriptorsOf(F.OlderVersion), undefined)
        assert.deepEqual(fx.Artifact.Asked, [])
    })

    it('a version the catalogue has not verified is unavailable, whatever the registry holds', async () =>
    {
        const fx = new SourceFixture()
        fx.Artifact.Sets.set(F.Version, F.Set())
        await assert.rejects(fx.Source.DescriptorsOf(F.Version), ReleaseDescriptorsUnavailableError)
        fx.Records.Records.push(F.Record(F.Version, F.Set(), ReleaseState.Rejected))
        await assert.rejects(fx.Source.DescriptorsOf(F.Version), ReleaseDescriptorsUnavailableError)
        assert.deepEqual(fx.Artifact.Asked, [])
    })

    it('a registry that cannot be reached fails the read; it never falls back to GitHub', async () =>
    {
        const { fx } = SourceFixture.WithArtifact()
        fx.Artifact.Error = new OciUnavailableError('registry unreachable')
        await assert.rejects(fx.Source.DescriptorsOf(F.Version), OciUnavailableError)
        assert.deepEqual(fx.Manifests.Asked, [])
    })
})
