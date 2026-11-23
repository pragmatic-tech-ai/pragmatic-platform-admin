import { CacheControl, HttpMethod, RouteAuth, type AuditTrail, type IOidcClientConfig, type OidcRelyingParty, type RequestContext, type RouteTable, type SignedInIdentity } from '@pragmatic-tech-ai/pragmatic-app-host'
import { OperatorRoleClaims, type OperatorSessions } from '../operator-sessions.js'
import { PlatformAdminComponent } from '../platform-admin-component.js'
import { OperatorSignInMethod, StaffOperatorRole, type OperatorDirectory } from './operator-directory.js'
import { OperatorOidcSettings } from './operator-oidc-settings.js'
import { OidcFlowBinding } from './oidc-flow-binding.js'

/** How a staff sign-in ended. */
export enum OperatorSignInOutcome
{
    /** A session was issued. */
    SignedIn = 'signed-in',
    /** The realm signed the person in, but gave them no operator role of this console: no session. */
    NoOperatorRole = 'no-operator-role',
    /** The realm gave an operator role, but an operator disabled this person in the operator directory: no session. */
    Disabled = 'disabled',
    /** The sign-in did not complete (state, nonce, PKCE, the browser binding, the code exchange, the token check or a
     *  store refused it): no session. */
    Failed = 'failed',
}

/** The end of one staff sign-in: the outcome and, when signed in, the session's token and expiry (never logged). */
export class OperatorSignInResult
{
    private constructor(public readonly Outcome: OperatorSignInOutcome, public readonly Token: string | undefined, public readonly ExpiresAt: Date | undefined)
    {
        Object.freeze(this)
    }

    public static SignedIn(token: string, expiresAt: Date): OperatorSignInResult
    {
        return new OperatorSignInResult(OperatorSignInOutcome.SignedIn, token, expiresAt)
    }

    public static Refused(outcome: OperatorSignInOutcome): OperatorSignInResult
    {
        return new OperatorSignInResult(outcome, undefined, undefined)
    }
}

/** A begun staff sign-in: where the browser goes and the flow's state (bound to the browser by a cookie). */
export class OperatorSignInBegun
{
    public constructor(public readonly Url: string, public readonly State: string)
    {
        Object.freeze(this)
    }
}

/**
 * The platform admin console as an OIDC relying party of its operators' realm (the Pragmatic tenant's staff realm):
 * `GET /auth/oidc/begin` sends the browser to the realm (authorization code flow with state, nonce and PKCE, the flow
 * state in the console's database, the state's digest in a browser-binding cookie; begins are rate-limited per client
 * address), `GET /auth/oidc/callback` completes it. The realm issues this application's roles (`app_roles` for
 * `pragmatic-platform-admin`); only `operator.full` and `operator.read-only` count, other applications' roles are
 * dropped by the relying party. With an operator role (and not disabled in the operator directory) the operator gets a
 * session in the console's session store, as principal `oidc:<issuer>#<sub>` with the realm's email and the one
 * strongest operator role, recorded in the directory; without one no session is created (a recorded operator's role is
 * set to none, ending their sessions) and the browser lands on the sign-in page's forbidden state
 * (`/?sign_in=forbidden`); anything else lands on `/?sign_in=failed`, with only the failure's class logged. Each
 * completed or refused sign-in of a known person is written to the activity log under `staff:<email>`. The break-glass
 * password sign-in is not touched: it stays at `/api/login`.
 */
export class OperatorOidcSignIn
{
    /** The console's application name at the realm (its component name), whose roles the session keeps. */
    public static readonly Application = PlatformAdminComponent.Name
    public static readonly SignInParam = 'sign_in'
    public static readonly FailedMarker = 'failed'
    public static readonly ForbiddenMarker = 'forbidden'
    private static readonly AfterSignInPath = '/'
    private static readonly SignInPagePath = '/?'
    private static readonly CodeParam = 'code'
    private static readonly StateParam = 'state'
    private static readonly LocationHeader = 'Location'
    private static readonly SetCookieHeader = 'Set-Cookie'
    private static readonly RetryAfterHeader = 'Retry-After'
    private static readonly StatusFound = 302
    private static readonly StatusOk = 200
    private static readonly StatusForbidden = 403
    private static readonly StatusTooManyRequests = 429
    private static readonly MsPerSecond = 1000
    private static readonly TooManyMessage = 'Too many sign-in attempts'
    private static readonly ErrorField = 'error'
    private static readonly AuditAction = HttpMethod.Get
    private static readonly RefusedNote = OperatorSignInMethod.Staff + ' sign-in refused: '
    private static readonly LogPrefix = '[operator-sign-in] staff sign-in failed: '
    private static readonly UnknownErrorName = 'Error'
    private static readonly NoText = ''

    private readonly client: IOidcClientConfig
    private readonly binding: OidcFlowBinding

    public constructor(
        private readonly settings: OperatorOidcSettings,
        private readonly rp: OidcRelyingParty,
        private readonly directory: OperatorDirectory,
        private readonly sessions: OperatorSessions,
        private readonly audit?: AuditTrail,
        private readonly now: () => Date = () => new Date(),
        private readonly log: (...items: unknown[]) => void = console.error)
    {
        this.client = {
            Issuer: settings.Issuer,
            DiscoveryUrl: settings.DiscoveryUrl,
            ClientId: settings.ClientId,
            ClientSecret: settings.ClientSecret,
            RedirectUri: settings.RedirectUri,
            Application: OperatorOidcSignIn.Application,
            ...(settings.CaBundleFile === undefined ? {} : { CaBundleFile: settings.CaBundleFile }),
        }
        this.binding = new OidcFlowBinding(sessions.SecureCookie)
    }

    /** The realm's issuer (staff principals of any other issuer never authenticate). */
    public get Issuer(): string
    {
        return this.settings.Issuer
    }

    /** The sign-in routes (both public; neither is audited by the pipeline: the callback writes what it decided). */
    public Register(table: RouteTable): void
    {
        const S = OperatorOidcSettings
        table.Add({ Method: HttpMethod.Get, Pattern: S.BeginPath, Auth: RouteAuth.Public, Audited: false, Handler: ctx => this.HandleBegin(ctx) })
        table.Add({ Method: HttpMethod.Get, Pattern: S.CallbackPath, Auth: RouteAuth.Public, Audited: false, Handler: ctx => this.HandleCallback(ctx) })
    }

    /** A new sign-in: the realm's authorize URL and its state (state, nonce and PKCE verifier kept in the flow store). */
    public async Begin(): Promise<OperatorSignInBegun>
    {
        const begun = await this.rp.Begin(this.client)
        return new OperatorSignInBegun(begun.Url, begun.State)
    }

    /** Completes a sign-in from the callback's code and state; never throws (every failure is Failed, its class logged). */
    public async Complete(code: string, state: string): Promise<OperatorSignInResult>
    {
        const O = OperatorOidcSignIn
        let identity: SignedInIdentity
        try
        {
            identity = await this.rp.Complete(this.client, code, state)
        }
        catch (err)
        {
            this.LogFailure(err)
            return OperatorSignInResult.Refused(OperatorSignInOutcome.Failed)
        }
        try
        {
            const email = identity.Claims.First(OperatorRoleClaims.EmailClaim) ?? identity.Subject
            const principal = OperatorRoleClaims.StaffPrincipalOf(this.settings.Issuer, identity.Subject)
            const granted = identity.Claims.Values(OperatorRoleClaims.RoleClaim)
            // Deny by default: the session carries the one strongest operator role the realm gave.
            const role = granted.includes(StaffOperatorRole.Full) ? StaffOperatorRole.Full
                : granted.includes(StaffOperatorRole.ReadOnly) ? StaffOperatorRole.ReadOnly : StaffOperatorRole.None
            if (role === StaffOperatorRole.None)
            {
                // A recorded operator whose realm took the role away: their role is none here too (their sessions end).
                await this.directory.RecordSignIn(principal, email, StaffOperatorRole.None, this.now())
                await this.Audit(email, O.StatusForbidden, O.RefusedNote + OperatorSignInOutcome.NoOperatorRole)
                return OperatorSignInResult.Refused(OperatorSignInOutcome.NoOperatorRole)
            }
            if (await this.directory.IsDisabled(principal))
            {
                await this.Audit(email, O.StatusForbidden, O.RefusedNote + OperatorSignInOutcome.Disabled)
                return OperatorSignInResult.Refused(OperatorSignInOutcome.Disabled)
            }
            await this.directory.RecordSignIn(principal, email, role, this.now())
            const issued = await this.sessions.Store.Issue(principal, OperatorRoleClaims.OfStaff(email, role))
            await this.Audit(email, O.StatusOk, OperatorSignInMethod.Staff)
            return OperatorSignInResult.SignedIn(issued.Token, issued.Session.ExpiresAt)
        }
        catch (err)
        {
            this.LogFailure(err)
            return OperatorSignInResult.Refused(OperatorSignInOutcome.Failed)
        }
    }

    private async HandleBegin(ctx: RequestContext): Promise<void>
    {
        const O = OperatorOidcSignIn
        CacheControl.NoStore(ctx.Response)
        const allowed = await this.sessions.StaffBegins.Hit(ctx.ClientAddress)
        if (!allowed.Allowed)
        {
            ctx.Response.setHeader(O.RetryAfterHeader, String(Math.ceil(allowed.RetryAfterMs / O.MsPerSecond)))
            ctx.WriteJson(O.StatusTooManyRequests, { [O.ErrorField]: O.TooManyMessage })
            return
        }
        let begun: OperatorSignInBegun
        try
        {
            begun = await this.Begin()
        }
        catch (err)
        {
            this.LogFailure(err)
            this.Redirect(ctx, O.SignInPageWith(O.FailedMarker))
            return
        }
        ctx.Response.setHeader(O.SetCookieHeader, this.binding.Bind(begun.State))
        this.Redirect(ctx, begun.Url)
    }

    private async HandleCallback(ctx: RequestContext): Promise<void>
    {
        const O = OperatorOidcSignIn
        CacheControl.NoStore(ctx.Response)
        const code = ctx.Query.get(O.CodeParam) ?? O.NoText
        const state = ctx.Query.get(O.StateParam) ?? O.NoText
        const bound = state.length > 0 && this.binding.Matches(ctx.Request, state)
        const result = code.length === 0 || !bound ? OperatorSignInResult.Refused(OperatorSignInOutcome.Failed) : await this.Complete(code, state)
        const cookies = [this.binding.Clearing()]
        let location: string
        switch (result.Outcome)
        {
            case OperatorSignInOutcome.SignedIn:
                cookies.push(this.sessions.Cookie.Build(result.Token as string, result.ExpiresAt as Date))
                location = O.AfterSignInPath
                break
            case OperatorSignInOutcome.NoOperatorRole:
            case OperatorSignInOutcome.Disabled:
                location = O.SignInPageWith(O.ForbiddenMarker)
                break
            case OperatorSignInOutcome.Failed:
                location = O.SignInPageWith(O.FailedMarker)
                break
        }
        ctx.Response.setHeader(O.SetCookieHeader, cookies)
        this.Redirect(ctx, location)
    }

    private Redirect(ctx: RequestContext, location: string): void
    {
        ctx.Response.writeHead(OperatorOidcSignIn.StatusFound, { [OperatorOidcSignIn.LocationHeader]: location })
        ctx.Response.end()
    }

    private async Audit(email: string, status: number, note: string): Promise<void>
    {
        await this.audit?.Record(OperatorRoleClaims.StaffActorOf(email), OperatorOidcSignIn.AuditAction, OperatorOidcSettings.CallbackPath, status, note)
    }

    /** Only the failure's class: never its message (it could carry a code, a state or a token). */
    private LogFailure(err: unknown): void
    {
        this.log(OperatorOidcSignIn.LogPrefix + (err instanceof Error ? err.name : OperatorOidcSignIn.UnknownErrorName))
    }

    private static SignInPageWith(marker: string): string
    {
        return OperatorOidcSignIn.SignInPagePath + new URLSearchParams({ [OperatorOidcSignIn.SignInParam]: marker }).toString()
    }
}
