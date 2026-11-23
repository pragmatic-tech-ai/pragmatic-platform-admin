import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { PlatformAdminComponent } from '../src/platform-admin-component.js'
import { Components } from '../src/release-components.js'
import { PlatformAdminGolden } from '../src/tests/platform-admin-golden.js'

class DescriptorGoldenFixture
{
    public static readonly RepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    public static readonly PackageJson = join(DescriptorGoldenFixture.RepoRoot, 'package.json')
    public static readonly Utf8 = 'utf8'
}

describe('descriptor golden', () =>
{
    it('the descriptor this repository emits has exactly the golden digest (the pragmatic-server pin, re-pinned per version)', () =>
    {
        const F = DescriptorGoldenFixture
        const descriptor = Components.Of(ReleaseApp.PlatformAdmin)
        assert.equal(descriptor.ContentDigest(), PlatformAdminGolden.Digest)
        assert.deepEqual(descriptor.ToJson(), JSON.parse(readFileSync(PlatformAdminGolden.Fixture, F.Utf8)))
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
