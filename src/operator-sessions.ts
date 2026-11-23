import type { IncomingMessage } from 'node:http'
import {
    InMemorySessionRepository,
    InMemoryThrottleRepository,
    InMemoryTicketRepository,
    HttpMethod,
    LoginThrottle,
    RateLimiter,
    type AuditTrail,
    SessionClaims,
    SessionCookie,
    SessionGate,
    SessionPolicy,
    SessionRecord,
    SessionStore,
    SignedInIdentity,
    WsTicketStore,
    type IPasswordAuthenticator,
    type ISessionRepository,
    type IThrottleRepository,
    type ITicketRepository,
    type LoginThrottleOptions,
    type WsTicketStoreOptions,
} from '@pragmatic-tech-ai/pragmatic-app-host'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal } from './operator-identity.js'
import { OperatorSignInMethod, StaffOperatorRole, type IStaffOperatorStanding } from './operator-sign-in/operator-directory.js'

/**
 * The operator roles as session claims: the platform admin console's application roles (declared in its component
 * descriptor), carried in the `app_roles` claim beside the operator's `email`. The console's routes name them as their
 * `AppRole` and ClaimsAuthorizer checks them against `app_roles`.
 */
export class OperatorRoleClaims
{
    /** The console's application role that may change the platform (an Owner grant on the operator realm). */
    public static readonly Full = 'operator.full'
    /** The console's application role that may only observe (a Viewer grant, or no Owner grant). */
    public static readonly ReadOnly = 'operator.read-only'
    /** Both roles: what a route open to every operator names. */
    public static readonly Any: readonly string[] = [OperatorRoleClaims.Full, OperatorRoleClaims.ReadOnly]
    /** The claim the roles travel in (the application-roles claim of the realm's sessions). */
    public static readonly RoleClaim = 'app_roles'
    public static readonly EmailClaim = 'email'
    /** Who the activity log names (AuditActorClaim): a break-glass operator's email, `staff:<email>` for a staff
     *  operator, so the two can never read as one actor even with the same email. */
    public static readonly ActorClaim = 'actor'
    private static readonly StaffActorPrefix = 'staff:'
    /** The claim a tenant-plane session names its tenant by (TenantSessionClaims.TenantClaim): never on an operator session. */
    public static readonly TenantClaim = 'tenant'
    /** How the session was signed in (the OIDC `amr` claim): `pwd` for the console's own operator accounts. */
    public static readonly MethodClaim = 'amr'
    public static readonly PasswordMethod = 'pwd'
    /** The method of a staff session: signed in through the realm (the console's OIDC relying party). */
    public static readonly StaffMethod = 'oidc'
    /** A staff operator's principal: `oidc:<issuer>#<subject>`, never the id of an operator account. */
    private static readonly StaffPrincipalPrefix = 'oidc:'
    private static readonly StaffPrincipalSeparator = '#'
    private static readonly NoSubject = ''

    public static NameOf(role: OperatorRole): string
    {
        return role === OperatorRole.Full ? OperatorRoleClaims.Full : OperatorRoleClaims.ReadOnly
    }

    /** The session claims of an operator account: its email, its role and the password sign-in method. */
    public static Of(principal: OperatorPrincipal): SessionClaims
    {
        const C = OperatorRoleClaims
        return SessionClaims.From({ [C.EmailClaim]: principal.email, [C.ActorClaim]: principal.email, [C.RoleClaim]: [C.NameOf(principal.role)], [C.MethodClaim]: [C.PasswordMethod] })
    }

    /** The session claims of a staff operator: the realm's email, the actor `staff:<email>`, the one operator role the
     *  operator holds, the staff sign-in method. */
    public static OfStaff(email: string, role: StaffOperatorRole): SessionClaims
    {
        const C = OperatorRoleClaims
        return SessionClaims.From({ [C.EmailClaim]: email, [C.ActorClaim]: C.StaffActorPrefix + email, [C.RoleClaim]: [role], [C.MethodClaim]: [C.StaffMethod] })
    }

    /** The actor a staff operator's activity is recorded under. */
    public static StaffActorOf(email: string): string
    {
        return OperatorRoleClaims.StaffActorPrefix + email
    }

    /** The principal a staff operator's sessions and directory record carry: issuer and subject, so two realms never collide. */
    public static StaffPrincipalOf(issuer: string, subject: string): string
    {
        return OperatorRoleClaims.StaffPrincipalPrefix + issuer + OperatorRoleClaims.StaffPrincipalSeparator + subject
    }

    /** Whether a staff principal was signed in by `issuer` (a principal of another realm never authenticates). */
    public static IsStaffPrincipalOf(principal: string, issuer: string): boolean
    {
        return principal.startsWith(OperatorRoleClaims.StaffPrincipalOf(issuer, OperatorRoleClaims.NoSubject))
    }

    /** Whether the session was signed in through the realm (a staff operator). */
    public static IsStaffSession(session: SessionRecord): boolean
    {
        return session.Claims.Has(OperatorRoleClaims.MethodClaim, OperatorRoleClaims.StaffMethod)
            && session.Subject.startsWith(OperatorRoleClaims.StaffPrincipalPrefix)
    }

    /** Whether the session belongs to one of the console's own operator accounts (signed in with its password). */
    public static IsOperatorAccount(session: SessionRecord): boolean
    {
        return session.Claims.Has(OperatorRoleClaims.MethodClaim, OperatorRoleClaims.PasswordMethod)
    }

    /** The operator a session names: its subject, email and role (ReadOnly unless the claims say Full: deny by default). */
    public static PrincipalOf(session: SessionRecord): OperatorPrincipal
    {
        const role = session.Claims.Has(OperatorRoleClaims.RoleClaim, OperatorRoleClaims.Full) ? OperatorRole.Full : OperatorRole.ReadOnly
        return { email: session.Claims.First(OperatorRoleClaims.EmailClaim) ?? session.Subject, principalId: session.Subject, role }
    }
}

/**
 * The authentication step of the platform admin console: the cookie's session from the session store. A session of one
 * of the console's own operator accounts (the break-glass password sign-in) has its claims refreshed from the account on
 * every request, so a demotion, a promotion or a disabled account takes effect at once while the role still reaches
 * authorization as a claim. A staff session (the realm's OIDC sign-in) has its role re-derived from the operator
 * directory on every request (StaffSessionPolicy): it authenticates only while its principal belongs to the configured
 * realm, is recorded there, is not disabled and holds an operator role; staff sign-in off refuses every staff session.
 * Any other session (the co-hosted tenant plane's, or a shape this console never issues) is refused: deny by default.
 */
export class OperatorSessionGate extends SessionGate
{
    public constructor(sessions: SessionStore, cookie: SessionCookie, private readonly operators: IOperatorIdentity, private readonly staff?: StaffSessionPolicy)
    {
        super(sessions, cookie)
    }

    public override async Current(req: IncomingMessage): Promise<SessionRecord | null>
    {
        const session = await super.Current(req)
        return session === null ? null : await this.Refreshed(session)
    }

    /**
     * The session with its claims as the operator's account says now; null when the operator is gone or disabled, or when
     * it is not an operator session at all (a session of the co-hosted tenant plane, which shares the session table, names
     * its tenant: it never authenticates here). A staff session as StaffSessionPolicy rebuilds it from the directory.
     */
    public async Refreshed(session: SessionRecord): Promise<SessionRecord | null>
    {
        if (session.Claims.First(OperatorRoleClaims.TenantClaim) !== undefined)
        {
            return null
        }
        if (OperatorRoleClaims.IsStaffSession(session))
        {
            return this.staff === undefined ? null : await this.staff.Refreshed(session)
        }
        if (!OperatorRoleClaims.IsOperatorAccount(session))
        {
            return null
        }
        const principal = await this.operators.PrincipalOf(session.Subject)
        if (principal === null)
        {
            return null
        }
        return new SessionRecord(session.Id, session.Subject, OperatorRoleClaims.Of(principal), session.IssuedAt, session.ExpiresAt, session.KeptAt, session.Policy)
    }
}

/**
 * Which staff sessions authenticate: those of principals signed in by the configured realm (`issuer`) that the operator
 * directory (`standing`) holds as active with an operator role. The session's claims are rebuilt from the directory's
 * role on every request, so the realm taking a role away (recorded at the operator's next sign-in attempt) or an
 * operator disabling them here ends their access at once.
 */
export class StaffSessionPolicy
{
    public constructor(private readonly issuer: string, private readonly standing: IStaffOperatorStanding)
    {
    }

    /** The session with its role as the directory says now, or null when it must not authenticate. */
    public async Refreshed(session: SessionRecord): Promise<SessionRecord | null>
    {
        if (!OperatorRoleClaims.IsStaffPrincipalOf(session.Subject, this.issuer))
        {
            return null
        }
        const role = await this.standing.RoleOf(session.Subject)
        if (role === StaffOperatorRole.None)
        {
            return null
        }
        const email = session.Claims.First(OperatorRoleClaims.EmailClaim) ?? session.Subject
        return new SessionRecord(session.Id, session.Subject, OperatorRoleClaims.OfStaff(email, role), session.IssuedAt, session.ExpiresAt, session.KeptAt, session.Policy)
    }
}

/**
 * The break-glass password sign-in of PasswordLoginEndpoint over the operator accounts. Every successful one is written
 * to the activity log as a `break-glass` sign-in of the operator (never the password); a failed one is not (no subject).
 * The entry is written once the password is verified, just before PasswordLoginEndpoint issues the session: if issuing
 * then fails, the log shows a sign-in whose session never existed (accepted: the entry records a proven password).
 */
export class OperatorPasswordAuthenticator implements IPasswordAuthenticator
{
    private static readonly AuditAction = HttpMethod.Post
    private static readonly StatusOk = 200

    public constructor(private readonly operators: IOperatorIdentity, private readonly audit?: AuditTrail, private readonly loginPath: string = OperatorSessions.LoginPath)
    {
    }

    public async Authenticate(account: string, password: string): Promise<SignedInIdentity | null>
    {
        const P = OperatorPasswordAuthenticator
        const principal = await this.operators.Verify(account, password)
        if (principal === null)
        {
            return null
        }
        await this.audit?.Record(principal.email, P.AuditAction, this.loginPath, P.StatusOk, OperatorSignInMethod.BreakGlass)
        return new SignedInIdentity(principal.principalId, OperatorRoleClaims.Of(principal))
    }
}

/** Overrides of the session layer's defaults (tests: a clock, short ticket lifetimes, a tighter throttle). */
export interface OperatorSessionOptions
{
    readonly Tickets?: WsTicketStoreOptions
    readonly Login?: LoginThrottleOptions
    readonly Now?: () => Date
}

/** Where the console's session state lives: the sessions, the WebSocket tickets and the throttles (Postgres in
 *  production, memory in tests). */
export interface OperatorSessionRepositories
{
    readonly Sessions: ISessionRepository
    readonly Tickets: ITicketRepository
    readonly Throttles: IThrottleRepository
}

/**
 * The operator session layer of the platform admin console: the session store (one hour from sign-in, as before), the
 * `cp_session` cookie, the event-socket tickets, the sign-in throttle and the denial limiter, over one set of repositories.
 */
export class OperatorSessions
{
    /** An operator session lives one hour from sign-in (it does not slide). */
    public static readonly TtlMs = 60 * 60 * 1000
    /** The console's cookie name (unchanged from the identity-pack sessions). */
    public static readonly CookieName = 'cp_session'
    /** The break-glass password sign-in route (PasswordLoginEndpoint). */
    public static readonly LoginPath = '/api/login'
    /** Refused unauthenticated mutations per client address: 30 a minute, then a minute locked (the host's default). */
    private static readonly DenialName = 'denials'
    private static readonly DenialMaxHits = 30
    private static readonly DenialWindowMs = 60_000
    private static readonly DenialLockoutMs = 60_000
    /** Staff sign-in begins per client address (each writes a flow state): 20 a minute, then a minute locked. */
    private static readonly StaffBeginName = 'staff-begins'
    private static readonly StaffBeginMaxHits = 20
    private static readonly StaffBeginWindowMs = 60_000
    private static readonly StaffBeginLockoutMs = 60_000

    public readonly Store: SessionStore
    public readonly Cookie: SessionCookie
    public readonly Tickets: WsTicketStore
    public readonly LoginThrottle: LoginThrottle
    /** The host's denial limiter over the same (persistent) throttle repository. */
    public readonly Denials: RateLimiter
    /** Limits staff sign-in begins per client address, over the same repository. */
    public readonly StaffBegins: RateLimiter
    /** Whether the console's cookies are Secure (the session cookie and the staff sign-in's flow binding). */
    public readonly SecureCookie: boolean

    /** The operator identity ends sessions through Store, so the layer exists before the identity; GateOver joins them. */
    public constructor(repositories: OperatorSessionRepositories, secureCookie: boolean, options: OperatorSessionOptions = {})
    {
        this.Store = new SessionStore(repositories.Sessions, new SessionPolicy(OperatorSessions.TtlMs), options.Now)
        this.Cookie = new SessionCookie({ Name: OperatorSessions.CookieName, Secure: secureCookie })
        this.Tickets = new WsTicketStore(repositories.Tickets, options.Tickets)
        this.LoginThrottle = new LoginThrottle(repositories.Throttles, options.Login)
        const S = OperatorSessions
        this.Denials = new RateLimiter(repositories.Throttles, { Name: S.DenialName, MaxHits: S.DenialMaxHits, WindowMs: S.DenialWindowMs, LockoutMs: S.DenialLockoutMs })
        this.StaffBegins = new RateLimiter(repositories.Throttles, { Name: S.StaffBeginName, MaxHits: S.StaffBeginMaxHits, WindowMs: S.StaffBeginWindowMs, LockoutMs: S.StaffBeginLockoutMs })
        this.SecureCookie = secureCookie
    }

    /** The authentication step over these sessions, refreshing each session's claims from `operators`; staff sessions
     *  authenticate only through `staff` (staff sign-in on). */
    public GateOver(operators: IOperatorIdentity, staff?: StaffSessionPolicy): OperatorSessionGate
    {
        return new OperatorSessionGate(this.Store, this.Cookie, operators, staff)
    }

    /** Process-local repositories: tests and tools that keep nothing (`now`: the tickets' and throttles' clock). */
    public static InMemory(now: () => number = Date.now): OperatorSessionRepositories
    {
        return { Sessions: new InMemorySessionRepository(), Tickets: new InMemoryTicketRepository(undefined, now), Throttles: new InMemoryThrottleRepository(undefined, now) }
    }
}
