import { type GitHubFetch, ReleaseManifest, type ReleaseManifestDocument, ReleaseRegistry } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import type { IReleaseManifestSource } from './release-descriptor-source.js'
import { GitHubRateLimit } from './github-rate-limit.js'

/** GitHub could not be asked for a release manifest, or answered something that is not one. One fixed sentence; never the body. */
export class ReleaseManifestUnavailableError extends Error
{
    private static readonly ErrorName = 'ReleaseManifestUnavailableError'

    public constructor(message: string)
    {
        super(message)
        this.name = ReleaseManifestUnavailableError.ErrorName
    }
}

/**
 * `release.json` of a platform release, read from pragmatic-platform-release at the release's tag `release/<version>`
 * through the GitHub contents API (raw media type; an injectable fetch seam). Anonymous: the repository is public, and the
 * manifest is only a pointer to each app's `component.json` asset, whose digest the caller checks against the signed one.
 * A 404 answers undefined; anything else that is not a manifest throws ReleaseManifestUnavailableError.
 */
export class GitHubReleaseManifestSource implements IReleaseManifestSource
{
    public static readonly DefaultApi = 'https://api.github.com'
    public static readonly DefaultRepository = 'pragmatic-tech-ai/pragmatic-platform-release'
    /** The tag the platform release workflow gives each release. */
    public static readonly TagPrefix = 'release/'
    public static readonly FileName = 'release.json'
    /** A release manifest is a few kilobytes; anything past this is not one. */
    public static readonly MaxBytes = 256 * 1024
    private static readonly ReposPath = '/repos/'
    private static readonly ContentsPath = '/contents/'
    private static readonly RefQuery = '?ref='
    private static readonly MethodGet = 'GET'
    private static readonly AcceptHeader = 'Accept'
    private static readonly ApiVersionHeader = 'X-GitHub-Api-Version'
    private static readonly UserAgentHeader = 'User-Agent'
    private static readonly RawType = 'application/vnd.github.raw+json'
    private static readonly ApiVersion = '2022-11-28'
    private static readonly UserAgent = 'pragmatic-platform-admin'
    private static readonly RedirectFollow = 'follow'
    private static readonly StatusOk = 200
    private static readonly StatusNotFound = 404
    private static readonly ContentLengthHeader = 'content-length'
    private static readonly NoLength = '0'
    private static readonly TrailingSlashes = /\/+$/
    private static readonly UnreachableMessage = 'GitHub is unreachable'
    private static readonly StatusMessagePrefix = 'GitHub answered HTTP '
    private static readonly TooLargeMessage = 'The release manifest is larger than a release manifest can be'
    private static readonly InvalidMessage = 'GitHub answered something that is not a release manifest'
    private static readonly GlobalFetch: GitHubFetch = (url, init) => fetch(url, init as RequestInit)

    private readonly api: string

    public constructor(
        private readonly fetchFn: GitHubFetch = GitHubReleaseManifestSource.GlobalFetch,
        private readonly repository: string = GitHubReleaseManifestSource.DefaultRepository,
        private readonly namespace: string = ReleaseRegistry.DefaultNamespace,
        api: string = GitHubReleaseManifestSource.DefaultApi,
    )
    {
        this.api = api.replace(GitHubReleaseManifestSource.TrailingSlashes, '')
    }

    /** The contents API URL of `release.json` at the tag of `version`. */
    public UrlOf(version: string): string
    {
        const S = GitHubReleaseManifestSource
        return this.api + S.ReposPath + this.repository + S.ContentsPath + S.FileName + S.RefQuery + encodeURIComponent(S.TagPrefix + version)
    }

    public async ManifestOf(version: string): Promise<ReleaseManifestDocument | undefined>
    {
        const S = GitHubReleaseManifestSource
        let response: Response
        try
        {
            response = await this.fetchFn(this.UrlOf(version), {
                method: S.MethodGet,
                headers: { [S.AcceptHeader]: S.RawType, [S.ApiVersionHeader]: S.ApiVersion, [S.UserAgentHeader]: S.UserAgent },
                redirect: S.RedirectFollow,
            })
        }
        catch
        {
            throw new ReleaseManifestUnavailableError(S.UnreachableMessage)
        }
        if (response.status === S.StatusNotFound)
        {
            return undefined
        }
        if (GitHubRateLimit.IsLimited(response))
        {
            throw new ReleaseManifestUnavailableError(GitHubRateLimit.Message)
        }
        if (response.status !== S.StatusOk)
        {
            throw new ReleaseManifestUnavailableError(S.StatusMessagePrefix + String(response.status))
        }
        // A declared length past the bound is refused before the body is read.
        const declared = Number(response.headers.get(S.ContentLengthHeader) ?? S.NoLength)
        if (declared > S.MaxBytes)
        {
            throw new ReleaseManifestUnavailableError(S.TooLargeMessage)
        }
        const bytes = await S.BoundedBody(response)
        try
        {
            return ReleaseManifest.Parse(new TextDecoder().decode(bytes), this.namespace)
        }
        catch
        {
            throw new ReleaseManifestUnavailableError(S.InvalidMessage)
        }
    }

    /** The body, read chunk by chunk and abandoned (the stream cancelled) as soon as it passes MaxBytes. */
    private static async BoundedBody(response: Response): Promise<Uint8Array>
    {
        const S = GitHubReleaseManifestSource
        const reader = response.body?.getReader()
        if (reader === undefined)
        {
            return new Uint8Array()
        }
        const chunks: Uint8Array[] = []
        let total = 0
        try
        {
            for (;;)
            {
                const { done, value } = await reader.read()
                if (done)
                {
                    break
                }
                total += value.length
                if (total > S.MaxBytes)
                {
                    await reader.cancel()
                    throw new ReleaseManifestUnavailableError(S.TooLargeMessage)
                }
                chunks.push(value)
            }
        }
        catch (error)
        {
            throw error instanceof ReleaseManifestUnavailableError ? error : new ReleaseManifestUnavailableError(S.UnreachableMessage)
        }
        const bytes = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks)
        {
            bytes.set(chunk, offset)
            offset += chunk.length
        }
        return bytes
    }
}
