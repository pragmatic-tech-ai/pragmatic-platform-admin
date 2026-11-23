import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/**
 * Ties a staff sign-in's callback to the browser that began it (login CSRF): begin sets a short-lived cookie holding
 * the SHA-256 of the flow's state (HttpOnly, SameSite=Lax so it travels on the realm's redirect back, scoped to
 * /auth/oidc, Secure as the console's cookies are); the callback completes only when the cookie's digest matches the
 * state it carries, and clears it. A callback link sent to someone else's browser has no matching cookie and fails.
 * The state itself never sits in the cookie.
 */
export class OidcFlowBinding
{
    public static readonly CookieName = 'cp_oidc_flow'
    private static readonly HashAlgorithm = 'sha256'
    private static readonly Encoding = 'base64url'
    private static readonly LifetimeSeconds = 600
    private static readonly CookiePath = '/auth/oidc'
    private static readonly AttributeSeparator = '; '
    private static readonly PairSeparator = ';'
    private static readonly ValueSeparator = '='
    private static readonly HttpOnly = 'HttpOnly'
    private static readonly SameSiteLax = 'SameSite=Lax'
    private static readonly Secure = 'Secure'
    private static readonly PathPrefix = 'Path='
    private static readonly MaxAgePrefix = 'Max-Age='
    private static readonly Cleared = ''
    private static readonly ExpiredMaxAge = 0

    public constructor(private readonly secure: boolean)
    {
    }

    /** The Set-Cookie value that binds the flow of `state` to this browser. */
    public Bind(state: string): string
    {
        return this.Cookie(OidcFlowBinding.Digest(state), OidcFlowBinding.LifetimeSeconds)
    }

    /** The Set-Cookie value that removes the binding. */
    public Clearing(): string
    {
        return this.Cookie(OidcFlowBinding.Cleared, OidcFlowBinding.ExpiredMaxAge)
    }

    /** Whether the request carries the binding of `state` (constant-time compare). */
    public Matches(req: IncomingMessage, state: string): boolean
    {
        const presented = OidcFlowBinding.Presented(req)
        if (presented === undefined)
        {
            return false
        }
        const expected = Buffer.from(OidcFlowBinding.Digest(state))
        const actual = Buffer.from(presented)
        return actual.length === expected.length && timingSafeEqual(actual, expected)
    }

    private Cookie(value: string, maxAge: number): string
    {
        const B = OidcFlowBinding
        const parts = [B.CookieName + B.ValueSeparator + value, B.PathPrefix + B.CookiePath, B.MaxAgePrefix + maxAge, B.HttpOnly, B.SameSiteLax]
        if (this.secure)
        {
            parts.push(B.Secure)
        }
        return parts.join(B.AttributeSeparator)
    }

    private static Presented(req: IncomingMessage): string | undefined
    {
        const B = OidcFlowBinding
        const header = req.headers.cookie
        if (typeof header !== 'string')
        {
            return undefined
        }
        for (const pair of header.split(B.PairSeparator))
        {
            const at = pair.indexOf(B.ValueSeparator)
            if (at > 0 && pair.slice(0, at).trim() === B.CookieName)
            {
                const value = pair.slice(at + 1).trim()
                return value.length === 0 ? undefined : value
            }
        }
        return undefined
    }

    private static Digest(state: string): string
    {
        return createHash(OidcFlowBinding.HashAlgorithm).update(state).digest(OidcFlowBinding.Encoding)
    }
}
