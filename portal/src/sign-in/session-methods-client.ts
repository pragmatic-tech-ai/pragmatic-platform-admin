import type { FetchFunction } from '@pragmatic-tech-ai/pragmatic-app-shell'
import type { ISessionMethodsSource } from './operator-sign-in-view-model.js'

/** GET /api/session/methods: `{ staff }`, whether the console offers staff sign-in. Public; an error rejects. */
export class SessionMethodsClient implements ISessionMethodsSource
{
    public static readonly MethodsPath = '/api/session/methods'
    private static readonly StaffField = 'staff'
    private static readonly GetMethod = 'GET'
    private static readonly SameOrigin: RequestCredentials = 'same-origin'
    private static readonly FailedPrefix = 'session methods: HTTP '
    /** The sign-in page waits at most this long before it shows the password form alone. */
    private static readonly TimeoutMs = 5000

    public constructor(private readonly fetcher: FetchFunction = (url, init) => fetch(url, init), private readonly timeoutMs: number = SessionMethodsClient.TimeoutMs)
    {
    }

    public async StaffSignInOffered(): Promise<boolean>
    {
        const S = SessionMethodsClient
        const reply = await this.fetcher(S.MethodsPath, { method: S.GetMethod, credentials: S.SameOrigin, signal: AbortSignal.timeout(this.timeoutMs) })
        if (!reply.ok)
        {
            throw new Error(S.FailedPrefix + reply.status)
        }
        const body = await reply.json() as Record<string, unknown>
        return body[S.StaffField] === true
    }
}
