import { CacheControl, HttpMethod, RouteAuth, type AuditTrail, type IOidcClientConfig, type OidcRelyingParty, type RequestContext, type RouteTable, type SignedInIdentity } from '@pragmatic-tech-ai/pragmatic-app-host'
import { OperatorRoleClaims, type OperatorSessions } from '../operator-sessions.js'
import { PlatformAdminComponent } from '../platform-admin-component.js'
import { OperatorSignInMethod, type OperatorDirectory } from './operator-directory.js'
import { OperatorOidcSettings } from './operator-oidc-settings.js'

/** How a staff sign-in ended. */
export enum OperatorSignInOutcome
{
    /** A session was issued. */
    SignedIn = 'signed-in',
    /** The realm signed the person in, but gave them no operator role of this console: no session. */
    NoOperatorRole = 'no-operator-role',
    /** The realm gave an operator role, but an operator disabled this person in the operator directory: no session. */
    Disabled = 'disabled',
    /** The sign-in did not complete (state, nonce, PKCE, the code exchange or the token check refused it): no session. */
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

/**
 * The platform admin console as an OIDC relying party of its operators' realm (the Pragmatic tenant's staff realm):
 * `GET /auth/oidc/begin` sends the browser to the realm (authorization code flow with state, nonce and PKCE, the flow
 * state in the console's database), `GET /auth/oidc/callback` completes it. The realm issues this application's roles
 * (`app_roles` for `pragmatic-platform-admin`); only `operator.full` and `operator.read-only` count, any other
 * application's roles are dropped by the relying party. With an operator role (and not disabled in the operator
 * directory) the operator gets a session in the console's session store, as principal `oidc:<issuer>#<sub>` with the
 * realm's email and the one strongest operator role, recorded in the directory; without one no session is created and the
 * browser lands on the sign-in page's forbidden state (`/?sign_in=forbidden`); a failed sign-in lands on
 * `/?sign_in=failed`. Each completed or refused sign-in of a known person is written to the activity log as a `staff`
 * sign-in. The break-glass password sign-in is not touched: it stays at `/api/login`.
 */
export class OperatorOidcSignIn
{
    /** The console's application name at the realm (its component name), whose roles the session keeps. */
    public static readonly Application = PlatformAdminComponent.Name
    public static readonly SignInParam = 'sign_in'
    private static readonly AfterSignInPath = '/'
    private static readonly SignInPagePath = '/?'
    private static readonly FailedMarker = 'failed'
    private static readonly ForbiddenMarker = 'forbidden'
    private static readonly CodeParam = 'code'
    private static readonly StateParam = 'state'
    private static readonly LocationHeader = 'Location'
    private static readonly SetCookieHeader = 'Set-Cookie'
    private static readonly StatusFound = 302
    private static readonly StatusOk = 200
    private static readonly StatusForbidden = 403
    private static readonly AuditAction = 'GET'
    private static readonly RefusedNote = OperatorSignInMethod.Staff + ' sign-in refused: '
    private static readonly OperatorRoles: readonly string[] = [OperatorRoleClaims.Full, OperatorRoleClaims.ReadOnly]

    private readonly client: IOidcClientConfig
    private audit: AuditTrail | undefined

    public constructor(
        private readonly settings: OperatorOidcSettings,
        private readonly rp: OidcRelyingParty,
        private readonly directory: OperatorDirectory,
        private readonly sessions: OperatorSessions,
        private readonly now: () => Date = () => new Date())
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
        // The callback arrives as a cross-site redirect from the realm: a Strict cookie would not travel on the navigation
        // that follows it, so the console's session cookie is Lax while staff sign-in is on (D5 ruling 15).
        sessions.Cookie.AdmitCrossSiteSignIn()
    }

    /** The sign-in routes (both public; neither is audited by the pipeline: the callback writes what it decided to
     *  `audit`, the console's activity log). */
    public Register(table: RouteTable, audit?: AuditTrail): void
    {
        this.audit = audit
        const S = OperatorOidcSettings
        table.Add({ Method: HttpMethod.Get, Pattern: S.BeginPath, Auth: RouteAuth.Public, Audited: false, Handler: ctx => this.HandleBegin(ctx) })
        table.Add({ Method: HttpMethod.Get, Pattern: S.CallbackPath, Auth: RouteAuth.Public, Audited: false, Handler: ctx => this.HandleCallback(ctx) })
    }

    /** The realm's authorize URL of a new sign-in (its state, nonce and PKCE verifier kept in the flow store). */
    public async Begin(): Promise<string>
    {
        return (await this.rp.Begin(this.client)).Url
    }

    /** Completes a sign-in from the callback's code and state; never throws for a refused or failed one. */
    public async Complete(code: string, state: string): Promise<OperatorSignInResult>
    {
        const O = OperatorOidcSignIn
        let identity: SignedInIdentity
        try
        {
            identity = await this.rp.Complete(this.client, code, state)
        }
        catch
        {
            return OperatorSignInResult.Refused(OperatorSignInOutcome.Failed)
        }
        const email = identity.Claims.First(OperatorRoleClaims.EmailClaim) ?? identity.Subject
        const principal = OperatorRoleClaims.StaffPrincipalOf(this.settings.Issuer, identity.Subject)
        const granted = identity.Claims.Values(OperatorRoleClaims.RoleClaim).filter(role => O.OperatorRoles.includes(role))
        if (granted.length === 0)
        {
            await this.Audit(email, O.StatusForbidden, O.RefusedNote + OperatorSignInOutcome.NoOperatorRole)
            return OperatorSignInResult.Refused(OperatorSignInOutcome.NoOperatorRole)
        }
        if (await this.directory.IsDisabled(principal))
        {
            await this.Audit(email, O.StatusForbidden, O.RefusedNote + OperatorSignInOutcome.Disabled)
            return OperatorSignInResult.Refused(OperatorSignInOutcome.Disabled)
        }
        // Deny by default: the session carries the one strongest operator role the realm gave.
        const role = granted.includes(OperatorRoleClaims.Full) ? OperatorRoleClaims.Full : OperatorRoleClaims.ReadOnly
        await this.directory.RecordSignIn(principal, email, role, this.now())
        const issued = await this.sessions.Store.Issue(principal, OperatorRoleClaims.OfStaff(email, [role]))
        await this.Audit(email, O.StatusOk, OperatorSignInMethod.Staff)
        return OperatorSignInResult.SignedIn(issued.Token, issued.Session.ExpiresAt)
    }

    private async HandleBegin(ctx: RequestContext): Promise<void>
    {
        CacheControl.NoStore(ctx.Response)
        let location: string
        try
        {
            location = await this.Begin()
        }
        catch
        {
            location = OperatorOidcSignIn.SignInPageWith(OperatorOidcSignIn.FailedMarker)
        }
        this.Redirect(ctx, location)
    }

    private async HandleCallback(ctx: RequestContext): Promise<void>
    {
        const O = OperatorOidcSignIn
        CacheControl.NoStore(ctx.Response)
        const code = ctx.Query.get(O.CodeParam) ?? ''
        const state = ctx.Query.get(O.StateParam) ?? ''
        const result = code.length === 0 || state.length === 0 ? OperatorSignInResult.Refused(OperatorSignInOutcome.Failed) : await this.Complete(code, state)
        switch (result.Outcome)
        {
            case OperatorSignInOutcome.SignedIn:
                ctx.Response.setHeader(O.SetCookieHeader, this.sessions.Cookie.Build(result.Token as string, result.ExpiresAt as Date))
                this.Redirect(ctx, O.AfterSignInPath)
                return
            case OperatorSignInOutcome.NoOperatorRole:
            case OperatorSignInOutcome.Disabled:
                this.Redirect(ctx, O.SignInPageWith(O.ForbiddenMarker))
                return
            case OperatorSignInOutcome.Failed:
                this.Redirect(ctx, O.SignInPageWith(O.FailedMarker))
                return
        }
    }

    private Redirect(ctx: RequestContext, location: string): void
    {
        ctx.Response.writeHead(OperatorOidcSignIn.StatusFound, { [OperatorOidcSignIn.LocationHeader]: location })
        ctx.Response.end()
    }

    private async Audit(email: string, status: number, note: string): Promise<void>
    {
        await this.audit?.Record(email, OperatorOidcSignIn.AuditAction, OperatorOidcSettings.CallbackPath, status, note)
    }

    private static SignInPageWith(marker: string): string
    {
        return OperatorOidcSignIn.SignInPagePath + new URLSearchParams({ [OperatorOidcSignIn.SignInParam]: marker }).toString()
    }
}
