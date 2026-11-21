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
    /** pragmatic-server's pin (src/component and admin/control-plane/descriptors/digests.json at the seed commit). */
    public static readonly Digest = 'sha256:bc19deb009e41d7d5dc0b19547410345dc451d11e800499f74ae9f507461898f'
    public static readonly Golden = join(DescriptorGoldenFixture.RepoRoot, 'src', 'tests', 'fixtures', 'pragmatic-platform-admin.component.json')
    public static readonly PackageJson = join(DescriptorGoldenFixture.RepoRoot, 'package.json')
    public static readonly Utf8 = 'utf8'
}

describe('descriptor golden', () =>
{
    it('the descriptor this repository emits has exactly the pragmatic-server golden digest', () =>
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
