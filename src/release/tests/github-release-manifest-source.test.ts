import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { GitHubRequestInit } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { GitHubReleaseManifestSource, ReleaseManifestUnavailableError } from '../github-release-manifest-source.js'
import { GitHubRateLimit } from '../github-rate-limit.js'
import { ReleaseDescriptorFixtures as F } from '../../tests/release-descriptor-fixtures.js'

/** A GitHub that answers one fixed response per call and records what it was asked. */
class FakeGitHub
{
    public static readonly Leak = 'body-text-that-must-not-leak'
    public static readonly ExpectedUrl = 'https://api.github.com/repos/pragmatic-tech-ai/pragmatic-platform-release/contents/release.json?ref=release%2F0.1.0-early.7'
    public static readonly RawType = 'application/vnd.github.raw+json'
    public static readonly RateLimited = GitHubRateLimit.Message
    public static readonly Forbidden = 'GitHub answered HTTP 403'
    public static readonly RemainingHeader = 'x-ratelimit-remaining'
    public static readonly ChunkBytes = 64 * 1024
    public static readonly Get = 'GET'
    public static readonly Manual = 'manual'

    public readonly Calls: Array<{ url: string; init: GitHubRequestInit }> = []
    public BodyRead = false
    public Pulls = 0
    public Cancelled = false

    public constructor(private readonly answer: (github: FakeGitHub) => Response)
    {
    }

    public readonly Fetch = async (url: string, init: GitHubRequestInit): Promise<Response> =>
    {
        this.Calls.push({ url, init })
        return this.answer(this)
    }

    public static Json(value: unknown, status: number = 200): FakeGitHub
    {
        return new FakeGitHub(() => new Response(JSON.stringify(value), { status }))
    }
}

/** A small 200 response declaring `length`, which records whether its body was read. */
class TrackedResponse extends Response
{
    public constructor(private readonly github: FakeGitHub, length: string)
    {
        super('{}', { status: 200, headers: { 'content-length': length } })
    }

    public override async arrayBuffer(): Promise<ArrayBuffer>
    {
        this.github.BodyRead = true
        return await super.arrayBuffer()
    }
}

describe('GitHubReleaseManifestSource', () =>
{
    it('reads release.json at the release tag release/<version>, raw, without credentials', async () =>
    {
        const github = FakeGitHub.Json(F.Manifest(F.OlderVersion))
        const manifest = await new GitHubReleaseManifestSource(github.Fetch).ManifestOf(F.OlderVersion)
        assert.equal(manifest?.version, F.OlderVersion)
        assert.equal(manifest?.components['pragmatic-tenant-idp'].repository, F.Owner + 'pragmatic-tenant-idp')
        assert.equal(github.Calls[0]?.url, FakeGitHub.ExpectedUrl)
        assert.equal(github.Calls[0]?.init.headers['Accept'], FakeGitHub.RawType)
        assert.equal(github.Calls[0]?.init.headers['Authorization'], undefined)
    })

    it('a release without a tag answers undefined', async () =>
    {
        assert.equal(await new GitHubReleaseManifestSource(FakeGitHub.Json({ message: 'Not Found' }, 404).Fetch).ManifestOf(F.OlderVersion), undefined)
    })

    it('the rate limit (429, or 403 with none remaining) is named as such; another 403 is a plain refusal', async () =>
    {
        const limited = [
            new FakeGitHub(() => new Response('{}', { status: 429 })),
            new FakeGitHub(() => new Response('{}', { status: 403, headers: { [FakeGitHub.RemainingHeader]: '0' } })),
        ]
        for (const github of limited)
        {
            await assert.rejects(new GitHubReleaseManifestSource(github.Fetch).ManifestOf(F.OlderVersion),
                (err: unknown) => err instanceof ReleaseManifestUnavailableError && err.message === FakeGitHub.RateLimited)
        }
        const refused = new FakeGitHub(() => new Response('{}', { status: 403, headers: { [FakeGitHub.RemainingHeader]: '12' } }))
        await assert.rejects(new GitHubReleaseManifestSource(refused.Fetch).ManifestOf(F.OlderVersion),
            (err: unknown) => err instanceof ReleaseManifestUnavailableError && err.message === FakeGitHub.Forbidden)
    })

    it('a body without a declared length is read only up to the bound, then the stream is cancelled', async () =>
    {
        const github = new FakeGitHub(gh => new Response(new ReadableStream<Uint8Array>({
            pull: controller =>
            {
                gh.Pulls++
                controller.enqueue(new Uint8Array(FakeGitHub.ChunkBytes))
            },
            cancel: () =>
            {
                gh.Cancelled = true
            },
        }), { status: 200 }))
        await assert.rejects(new GitHubReleaseManifestSource(github.Fetch).ManifestOf(F.OlderVersion), /larger than a release manifest/)
        assert.equal(github.Cancelled, true)
        assert.ok(github.Pulls <= GitHubReleaseManifestSource.MaxBytes / FakeGitHub.ChunkBytes + 2, String(github.Pulls))
    })

    it('a declared length past the bound is refused before the body is read', async () =>
    {
        const github = new FakeGitHub(gh => new TrackedResponse(gh, String(GitHubReleaseManifestSource.MaxBytes + 1)))
        await assert.rejects(new GitHubReleaseManifestSource(github.Fetch).ManifestOf(F.OlderVersion), /larger than a release manifest/)
        assert.equal(github.BodyRead, false)
    })

    it('another status, an unreachable GitHub, an oversized or a non-manifest body throw one fixed sentence, never the body', async () =>
    {
        await assert.rejects(new GitHubReleaseManifestSource(FakeGitHub.Json({ message: FakeGitHub.Leak }, 500).Fetch).ManifestOf(F.OlderVersion),
            (err: unknown) => err instanceof ReleaseManifestUnavailableError && err.message === 'GitHub answered HTTP 500')
        const down = new GitHubReleaseManifestSource(async () => { throw new Error(FakeGitHub.Leak) })
        await assert.rejects(down.ManifestOf(F.OlderVersion), (err: unknown) => err instanceof ReleaseManifestUnavailableError && !err.message.includes(FakeGitHub.Leak))
        const huge = new FakeGitHub(() => new Response('x'.repeat(GitHubReleaseManifestSource.MaxBytes + 1), { status: 200 }))
        await assert.rejects(new GitHubReleaseManifestSource(huge.Fetch).ManifestOf(F.OlderVersion), /larger than a release manifest/)
        await assert.rejects(new GitHubReleaseManifestSource(FakeGitHub.Json({ schema: 1, note: FakeGitHub.Leak }).Fetch).ManifestOf(F.OlderVersion),
            (err: unknown) => err instanceof ReleaseManifestUnavailableError && !err.message.includes(FakeGitHub.Leak))
    })
})

describe('GitHubRateLimit', () =>
{
    it('records after each answer of the watched fetch whether it was the rate limit', async () =>
    {
        const answers = [
            new Response('{}', { status: 429 }),
            new Response('{}', { status: 200 }),
            new Response('{}', { status: 403, headers: { [FakeGitHub.RemainingHeader]: '0' } }),
            new Response('{}', { status: 403 }),
        ]
        const limit = new GitHubRateLimit()
        const fetchFn = limit.Watch(async () => answers.shift() as Response)
        const seen: boolean[] = []
        for (let i = 0; i < 4; i++)
        {
            await fetchFn(FakeGitHub.ExpectedUrl, { method: FakeGitHub.Get, headers: {}, redirect: FakeGitHub.Manual })
            seen.push(limit.Limited)
        }
        assert.deepEqual(seen, [true, false, true, false])
    })
})
