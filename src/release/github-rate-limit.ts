import type { GitHubFetch, GitHubRequestInit } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

/**
 * GitHub's rate limit as the release descriptor reads meet it: a 429, or a 403 whose `x-ratelimit-remaining` is 0 (any
 * other 403 is a plain refusal). `Watch` wraps a fetch so a reader whose own errors carry only the status (the toolkit's
 * GitHubComponentAssetSource) can still be told the last answer was the rate limit.
 */
export class GitHubRateLimit
{
    public static readonly Message = 'GitHub refused the request (rate limited); try again later'
    private static readonly StatusTooMany = 429
    private static readonly StatusForbidden = 403
    private static readonly RemainingHeader = 'x-ratelimit-remaining'
    private static readonly NoneRemaining = '0'

    private limited = false

    /** Whether a response is GitHub's rate limit. */
    public static IsLimited(response: Response): boolean
    {
        const R = GitHubRateLimit
        return response.status === R.StatusTooMany
            || (response.status === R.StatusForbidden && response.headers.get(R.RemainingHeader) === R.NoneRemaining)
    }

    /** Whether the last response the watched fetch answered was the rate limit. */
    public get Limited(): boolean
    {
        return this.limited
    }

    /** `fetchFn`, recording after every answer whether it was the rate limit. */
    public Watch(fetchFn: GitHubFetch): GitHubFetch
    {
        return async (url: string, init: GitHubRequestInit): Promise<Response> =>
        {
            const response = await fetchFn(url, init)
            this.limited = GitHubRateLimit.IsLimited(response)
            return response
        }
    }
}
