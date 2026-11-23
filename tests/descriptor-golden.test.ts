import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { PlatformAdminComponent } from '../src/platform-admin-component.js'
import { Components } from '../src/release-components.js'

class DescriptorGoldenFixture
{
    public static readonly RepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    /**
     * pragmatic-server's pin (src/component and admin/control-plane/descriptors/digests.json at the seed commit,
     * `sha256:bc19deb0…`), re-pinned at 0.1.1, where only the version field changed. Every release re-pins it.
     */
    public static readonly Digest = 'sha256:0a71493f54c0f31867ab4dc7079fea4bca3b3d4b415819a9e65bf71385fa20a0'
    public static readonly Golden = join(DescriptorGoldenFixture.RepoRoot, 'src', 'tests', 'fixtures', 'pragmatic-platform-admin.component.json')
    public static readonly PackageJson = join(DescriptorGoldenFixture.RepoRoot, 'package.json')
    public static readonly Utf8 = 'utf8'
}

describe('descriptor golden', () =>
{
    it('the descriptor this repository emits has exactly the golden digest (the pragmatic-server pin, re-pinned per version)', () =>
    {
        const F = DescriptorGoldenFixture
        const descriptor = Components.Of(ReleaseApp.PlatformAdmin)
        assert.equal(descriptor.ContentDigest(), F.Digest)
        assert.deepEqual(descriptor.ToJson(), JSON.parse(readFileSync(F.Golden, F.Utf8)))
        assert.deepEqual(Components.All().map(([app]) => app), [ReleaseApp.PlatformAdmin])
    })

    it('the descriptor version is the package version', () =>
    {
        const F = DescriptorGoldenFixture
        const manifest = JSON.parse(readFileSync(F.PackageJson, F.Utf8)) as { version: string }
        assert.equal(PlatformAdminComponent.Version, manifest.version)
        assert.equal(PlatformAdminComponent.Descriptor().Version, manifest.version)
    })
})
