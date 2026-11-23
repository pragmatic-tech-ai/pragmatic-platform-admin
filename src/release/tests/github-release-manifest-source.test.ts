import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { GitHubRequestInit } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { GitHubReleaseManifestSource, ReleaseManifestUnavailableError } from '../github-release-manifest-source.js'
import { ReleaseDescriptorFixtures as F } from '../../tests/release-descriptor-fixtures.js'

/** A GitHub that answers one fixed response per call and records what it was asked. */
class FakeGitHub
{
    public readonly Calls: Array<{ url: string; init: GitHubRequestInit }> = []

    public constructor(private readonly answer: () => Response)
    {
    }

    public readonly Fetch = async (url: string, init: GitHubRequestInit): Promise<Response> =>
    {
        this.Calls.push({ url, init })
        return this.answer()
    }

    public static Json(value: unknown, status: number = 200): FakeGitHub
    {
        return new FakeGitHub(() => new Response(JSON.stringify(value), { status }))
    }
}

describe('GitHubReleaseManifestSource', () =>
{
    it('reads release.json at the release tag release/<version>, raw, without credentials', async () =>
    {
        const github = FakeGitHub.Json(F.Manifest(F.OlderVersion))
        const manifest = await new GitHubReleaseManifestSource(github.Fetch).ManifestOf(F.OlderVersion)
        assert.equal(manifest?.version, F.OlderVersion)
        assert.equal(manifest?.components['pragmatic-tenant-idp'].repository, 'pragmatic-tech-ai/pragmatic-tenant-idp')
        assert.equal(github.Calls[0]?.url, 'https://api.github.com/repos/pragmatic-tech-ai/pragmatic-platform-release/contents/release.json?ref=release%2F0.1.0-early.7')
        assert.equal(github.Calls[0]?.init.headers['Accept'], 'application/vnd.github.raw+json')
        assert.equal(github.Calls[0]?.init.headers['Authorization'], undefined)
    })

    it('a release without a tag answers undefined', async () =>
    {
        assert.equal(await new GitHubReleaseManifestSource(FakeGitHub.Json({ message: 'Not Found' }, 404).Fetch).ManifestOf(F.OlderVersion), undefined)
    })

    it('another status, an unreachable GitHub, an oversized or a non-manifest body throw one fixed sentence, never the body', async () =>
    {
        const secretish = 'body-text-that-must-not-leak'
        await assert.rejects(new GitHubReleaseManifestSource(FakeGitHub.Json({ message: secretish }, 500).Fetch).ManifestOf(F.OlderVersion),
            (err: unknown) => err instanceof ReleaseManifestUnavailableError && err.message === 'GitHub answered HTTP 500')
        const down = new GitHubReleaseManifestSource(async () => { throw new Error(secretish) })
        await assert.rejects(down.ManifestOf(F.OlderVersion), (err: unknown) => err instanceof ReleaseManifestUnavailableError && !err.message.includes(secretish))
        const huge = new FakeGitHub(() => new Response('x'.repeat(GitHubReleaseManifestSource.MaxBytes + 1), { status: 200 }))
        await assert.rejects(new GitHubReleaseManifestSource(huge.Fetch).ManifestOf(F.OlderVersion), /larger than a release manifest/)
        await assert.rejects(new GitHubReleaseManifestSource(FakeGitHub.Json({ schema: 1, note: secretish }).Fetch).ManifestOf(F.OlderVersion),
            (err: unknown) => err instanceof ReleaseManifestUnavailableError && !err.message.includes(secretish))
    })
})
