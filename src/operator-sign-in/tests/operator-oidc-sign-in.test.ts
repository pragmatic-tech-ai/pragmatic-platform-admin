import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { AuditTrail, InMemoryAuditRepository, OidcRelyingParty } from '@pragmatic-tech-ai/pragmatic-app-host'
import { InMemoryOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { FakeOidcHttpClient, FakeOidcIdp } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import { MemoryRecordMap, type IEnvironmentService, type IGraphService } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ControlPlaneHost } from '../../control-plane-host.js'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSummary } from '../../operator-identity.js'
import { OperatorRoleClaims, OperatorSessions, StaffSessionPolicy } from '../../operator-sessions.js'
import type { PlatformDirectory } from '../../platform-directory.js'
import type { PlatformDeploymentRegistry } from '../../platform-deployment-registry.js'
import type { TenantProvisioningService } from '../../tenant-provisioning-service.js'
import type { HiveObservationRegistry } from '../../hive-observation-record.js'
import { OperatorDirectory, StaffOperatorRole, type StaffOperatorRecord } from '../operator-directory.js'
import { OperatorOidcSettings } from '../operator-oidc-settings.js'
import { OperatorOidcSignIn } from '../operator-oidc-sign-in.js'

/** One break-glass operator account (password `BreakGlassOperator.Password`), as the console's operator identity holds it. */
class BreakGlassOperator implements IOperatorIdentity
{
    public static readonly Email = 'owner@pragmatic.test'
    public static readonly Password = 'break-glass-password-1'
    public static readonly Principal: OperatorPrincipal = { email: BreakGlassOperator.Email, principalId: 'admin', role: OperatorRole.Full }

    public async Verify(email: string, password: string): Promise<OperatorPrincipal | null>
    {
        return email === BreakGlassOperator.Email && password === BreakGlassOperator.Password ? BreakGlassOperator.Principal : null
    }

    public async PrincipalOf(principalId: string): Promise<OperatorPrincipal | null>
    {
        return principalId === BreakGlassOperator.Principal.principalId ? BreakGlassOperator.Principal : null
    }

    public async ListOperators(): Promise<readonly OperatorSummary[]>
    {
        return [{ email: BreakGlassOperator.Email, role: OperatorRole.Full, disabled: false }]
    }

    public async CreateOperator(): Promise<void>
    {
    }

    public async SetOperatorRole(): Promise<void>
    {
    }

    public async ResetOperatorPassword(): Promise<string>
    {
        return ''
    }

    public async ChangeOwnPassword(): Promise<boolean>
    {
        return false
    }

    public async SetOperatorDisabled(): Promise<void>
    {
    }

    public async RevokeOperatorSessions(): Promise<void>
    {
    }
}

type Reply = { status: number; location: string | undefined; cookies: string[]; text: string }

/** A memory record map whose saves can be made to fail (a database that went away mid sign-in). */
class FailingRecordMap extends MemoryRecordMap<StaffOperatorRecord>
{
    private static readonly FailedMessage = 'the database went away'
    public FailSaves = false

    public override async Save(all: ReadonlyMap<string, StaffOperatorRecord>, changed: ReadonlySet<string>): Promise<void>
    {
        if (this.FailSaves)
        {
            throw new Error(FailingRecordMap.FailedMessage)
        }
        await super.Save(all, changed)
    }
}

/** How a fixture's console is set up: staff sign-in on or off, and whether the realm's discovery answers. */
enum RealmMode
{
    Off = 'off',
    On = 'on',
    Unreachable = 'unreachable',
}

/** A console with staff sign-in on (or off) against a fake realm, driven over HTTP like a browser. */
class StaffSignInFixture
{
    public static readonly Loopback = '127.0.0.1'
    public static readonly PublicUrl = 'https://admin.pragmatic.test'
    public static readonly ClientId = 'pragmatic-platform-admin'
    public static readonly ClientSecret = 'operator-client-secret'
    public static readonly Subject = 'account-7'
    public static readonly Email = 'staff@pragmatic.test'
    public static readonly Code = 'the-code'
    public static readonly Begin = '/auth/oidc/begin'
    public static readonly Callback = '/auth/oidc/callback'
    public static readonly Session = '/api/session'
    public static readonly SessionPassword = '/api/session/password'
    public static readonly Methods = '/api/session/methods'
    public static readonly Login = '/api/login'
    public static readonly Operators = '/api/operators'
    public static readonly Staff = '/api/operators/staff'
    public static readonly StaffDisabled = '/api/operators/staff/disabled'
    public static readonly Activity = '/api/activity'
    public static readonly SignedInLocation = '/'
    public static readonly ForbiddenLocation = '/?sign_in=forbidden'
    public static readonly FailedLocation = '/?sign_in=failed'
    public static readonly SessionCookie = 'cp_session='
    public static readonly FlowCookie = 'cp_oidc_flow='
    public static readonly UnknownDiscovery = 'https://unreachable.realm.test/.well-known/openid-configuration'
    public static readonly OtherIssuer = 'https://other.realm.test/realms/x'
    public static readonly Get = 'GET'
    public static readonly Post = 'POST'
    public static readonly TempPrefix = 'cp-staff-sign-in-'

    public readonly Root: string
    public readonly Audit = new InMemoryAuditRepository()
    public readonly Map = new FailingRecordMap()
    public readonly Directory: OperatorDirectory
    public readonly Logged: string[] = []
    public Sessions!: OperatorSessions
    public Host!: ControlPlaneHost
    public Idp!: FakeOidcIdp
    public Http!: FakeOidcHttpClient

    public constructor()
    {
        this.Root = mkdtempSync(join(tmpdir(), StaffSignInFixture.TempPrefix))
        this.Directory = new OperatorDirectory(this.Map)
    }

    public static async Start(mode: RealmMode): Promise<StaffSignInFixture>
    {
        const F = new StaffSignInFixture()
        F.Idp = await FakeOidcIdp.Create()
        F.Http = new FakeOidcHttpClient(F.Idp)
        F.Sessions = new OperatorSessions(OperatorSessions.InMemory(), false)
        const trail = new AuditTrail(F.Audit)
        const signIn = mode === RealmMode.Off ? undefined
            : new OperatorOidcSignIn(F.Settings(mode), new OidcRelyingParty(new InMemoryOidcFlowStateStore(), { Http: F.Http }), F.Directory, F.Sessions, trail, undefined, (...items: unknown[]) => { F.Logged.push(items.join(' ')) })
        const service = { ListReconciled: async () => [] } as unknown as IEnvironmentService
        F.Host = new ControlPlaneHost({ Service: service, Graphs: {} as IGraphService, PortalRoot: F.Root, Operator: new BreakGlassOperator(), Sessions: F.Sessions,
            Directory: {} as PlatformDirectory, Deployments: {} as PlatformDeploymentRegistry, Provisioning: {} as TenantProvisioningService, Observations: {} as HiveObservationRegistry,
            Audit: F.Audit, OperatorSignIn: signIn, StaffOperators: signIn === undefined ? undefined : F.Directory })
        await F.Host.Listen(0, StaffSignInFixture.Loopback)
        return F
    }

    public async Stop(): Promise<void>
    {
        await this.Host.Close()
        rmSync(this.Root, { recursive: true, force: true })
    }

    public get Principal(): string
    {
        return OperatorRoleClaims.StaffPrincipalOf(this.Idp.Issuer, StaffSignInFixture.Subject)
    }

    /** Begins a sign-in (keeping the browser binding cookie unless `dropBinding`), lets the realm answer the code
     *  exchange with an id token carrying `claims`, and follows the callback. */
    public async SignIn(claims: Record<string, unknown>, nonce?: string, dropBinding: boolean = false): Promise<{ reply: Reply; authorize: URL; flow: string }>
    {
        const begun = await this.Send(StaffSignInFixture.Get, StaffSignInFixture.Begin)
        const authorize = new URL(begun.location as string)
        const flow = StaffSignInFixture.CookieValue(begun, StaffSignInFixture.FlowCookie) ?? ''
        await this.Answer(nonce ?? authorize.searchParams.get('nonce') as string, claims)
        const reply = await this.Callback(authorize.searchParams.get('state') as string, dropBinding ? undefined : flow)
        return { reply, authorize, flow }
    }

    public Callback(state: string, flow: string | undefined, code: string = StaffSignInFixture.Code): Promise<Reply>
    {
        const cookie = flow === undefined ? undefined : StaffSignInFixture.FlowCookie + flow
        return this.Send(StaffSignInFixture.Get, StaffSignInFixture.Callback + '?code=' + encodeURIComponent(code) + '&state=' + encodeURIComponent(state), undefined, undefined, cookie)
    }

    public async Answer(nonce: string, claims: Record<string, unknown>): Promise<void>
    {
        const token = await this.Idp.MintIdToken({ sub: StaffSignInFixture.Subject, aud: StaffSignInFixture.ClientId, nonce, email: StaffSignInFixture.Email, ...claims })
        this.Http.NextTokenResponse = this.Idp.TokenResponse(token)
    }

    public static AppRoles(application: string, ...roles: string[]): Record<string, unknown>
    {
        return { app_roles: { [application]: roles } }
    }

    public static CookieValue(reply: Reply, prefix: string): string | undefined
    {
        const cookie = reply.cookies.find(c => c.startsWith(prefix))
        return cookie === undefined ? undefined : cookie.slice(prefix.length).split(';')[0]
    }

    public static TokenOf(reply: Reply): string
    {
        const token = StaffSignInFixture.CookieValue(reply, StaffSignInFixture.SessionCookie)
        assert.ok(token !== undefined && token.length > 0, reply.cookies.join(' | '))
        return token
    }

    public BreakGlass(): Promise<Reply>
    {
        return this.Send(StaffSignInFixture.Post, StaffSignInFixture.Login, undefined, JSON.stringify({ email: BreakGlassOperator.Email, password: BreakGlassOperator.Password }))
    }

    public Send(method: string, path: string, token?: string, body?: string, extraCookie?: string): Promise<Reply>
    {
        const addr = this.Host.Address()
        return new Promise((resolve, reject) => {
            const headers: Record<string, string> = { 'content-type': 'application/json' }
            const cookies = [token === undefined ? undefined : StaffSignInFixture.SessionCookie + token, extraCookie].filter(c => c !== undefined)
            if (cookies.length > 0)
            {
                headers.cookie = cookies.join('; ')
            }
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res => {
                let text = ''
                res.on('data', (c: Buffer) => { text += c.toString() })
                res.on('end', () => { resolve({ status: res.statusCode ?? 0, location: res.headers.location, cookies: res.headers['set-cookie'] ?? [], text }) })
            })
            req.on('error', reject)
            req.end(body)
        })
    }

    private Settings(mode: RealmMode): OperatorOidcSettings
    {
        const secretFile = join(this.Root, 'client-secret')
        writeFileSync(secretFile, StaffSignInFixture.ClientSecret + '\n')
        const settings = OperatorOidcSettings.Of({
            [OperatorOidcSettings.IssuerEnvVar]: this.Idp.Issuer,
            [OperatorOidcSettings.DiscoveryUrlEnvVar]: mode === RealmMode.Unreachable ? StaffSignInFixture.UnknownDiscovery : this.Idp.DiscoveryUrl,
            [OperatorOidcSettings.ClientIdEnvVar]: StaffSignInFixture.ClientId,
            [OperatorOidcSettings.ClientSecretFileEnvVar]: secretFile,
            [OperatorOidcSettings.PublicUrlEnvVar]: StaffSignInFixture.PublicUrl,
        })
        assert.ok(settings !== undefined)
        return settings
    }
}

describe('operator staff sign-in (OIDC) against the realm', () =>
{
    const F = StaffSignInFixture
    const app = OperatorOidcSignIn.Application
    let fixture: StaffSignInFixture

    beforeEach(async () =>
    {
        fixture = await StaffSignInFixture.Start(RealmMode.On)
    })

    afterEach(async () =>
    {
        await fixture.Stop()
    })

    it('a realm user with operator.full gets a full operator session', async () =>
    {
        const { reply } = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))
        assert.equal(reply.status, 302)
        assert.equal(reply.location, F.SignedInLocation)
        assert.ok(reply.cookies.some(c => c.startsWith(F.SessionCookie) && /SameSite=Lax/.test(c)))
        assert.ok(reply.cookies.some(c => c.startsWith(F.FlowCookie) && /Max-Age=0/.test(c)), 'the flow binding is cleared')
        const token = F.TokenOf(reply)
        const session = JSON.parse((await fixture.Send(F.Get, F.Session, token)).text) as { subject: string; claims: Record<string, string[]> }
        assert.equal(session.subject, fixture.Principal)
        assert.deepEqual(session.claims.app_roles, [OperatorRoleClaims.Full])
        assert.deepEqual(session.claims.amr, [OperatorRoleClaims.StaffMethod])
        assert.deepEqual(session.claims.email, [F.Email])
        assert.equal((await fixture.Send(F.Get, F.Operators, token)).status, 200)
        const recorded = await fixture.Directory.List()
        assert.deepEqual(recorded.map(r => [r.principal, r.email, r.role, r.method, r.disabled]), [[fixture.Principal, F.Email, StaffOperatorRole.Full, 'staff', false]])
        const audit = await fixture.Audit.Recent(10)
        assert.ok(audit.some(e => e.Actor === OperatorRoleClaims.StaffActorOf(F.Email) && e.Note === 'staff' && e.Status === 200))
    })

    it('operator.read-only gets a read-only session', async () =>
    {
        const { reply } = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.ReadOnly))
        const token = F.TokenOf(reply)
        assert.equal((await fixture.Send(F.Get, F.Activity, token)).status, 200)
        assert.equal((await fixture.Send(F.Get, F.Operators, token)).status, 403)
    })

    it('both roles: the session carries operator.full only', async () =>
    {
        const { reply } = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.ReadOnly, OperatorRoleClaims.Full))
        const session = JSON.parse((await fixture.Send(F.Get, F.Session, F.TokenOf(reply))).text) as { claims: Record<string, string[]> }
        assert.deepEqual(session.claims.app_roles, [OperatorRoleClaims.Full])
    })

    it('no operator role creates no session and answers the 403 page', async () =>
    {
        const { reply } = await fixture.SignIn({ roles: ['admin'], ...F.AppRoles(app, 'auditor') })
        assert.equal(reply.status, 302)
        assert.equal(reply.location, F.ForbiddenLocation)
        assert.equal(F.CookieValue(reply, F.SessionCookie), undefined)
        assert.deepEqual(await fixture.Directory.List(), [])
        const audit = await fixture.Audit.Recent(10)
        assert.ok(audit.some(e => e.Actor === OperatorRoleClaims.StaffActorOf(F.Email) && e.Status === 403 && (e.Note ?? '').includes('no-operator-role')))
    })

    it('roles of another application are ignored', async () =>
    {
        const { reply } = await fixture.SignIn({ app_roles: { 'pragmatic-ledger': [OperatorRoleClaims.Full], other: [OperatorRoleClaims.ReadOnly] }, roles: [OperatorRoleClaims.Full] })
        assert.equal(reply.location, F.ForbiddenLocation)
        assert.equal(F.CookieValue(reply, F.SessionCookie), undefined)
    })

    it('state, nonce and PKCE are checked', async () =>
    {
        const wrongNonce = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full), 'not-the-nonce')
        assert.equal(wrongNonce.reply.location, F.FailedLocation)
        assert.equal(F.CookieValue(wrongNonce.reply, F.SessionCookie), undefined)
        // The state was consumed by the failed attempt: replaying it fails too, even with a good token and its binding.
        const state = wrongNonce.authorize.searchParams.get('state') as string
        await fixture.Answer(wrongNonce.authorize.searchParams.get('nonce') as string, F.AppRoles(app, OperatorRoleClaims.Full))
        assert.equal((await fixture.Callback(state, wrongNonce.flow)).location, F.FailedLocation)
        assert.equal((await fixture.Callback('never-issued', wrongNonce.flow)).location, F.FailedLocation)
        assert.equal((await fixture.Callback(state, wrongNonce.flow, '')).location, F.FailedLocation)
        // A good sign-in posts the PKCE verifier whose S256 digest is the challenge the authorize URL carried.
        const good = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))
        assert.equal(good.reply.location, F.SignedInLocation)
        const posted = fixture.Http.PostedFields.at(-1)
        const verifier = posted?.get('code_verifier') ?? ''
        assert.equal(createHash('sha256').update(verifier).digest('base64url'), good.authorize.searchParams.get('code_challenge'))
        assert.equal(good.authorize.searchParams.get('code_challenge_method'), 'S256')
        assert.equal(good.authorize.searchParams.get('redirect_uri'), F.PublicUrl + F.Callback)
        assert.equal(posted?.get('client_secret'), F.ClientSecret)
    })

    it('a callback without the browser binding of its flow fails (login CSRF)', async () =>
    {
        const unbound = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full), undefined, true)
        assert.equal(unbound.reply.location, F.FailedLocation)
        assert.equal(F.CookieValue(unbound.reply, F.SessionCookie), undefined)
        // A flow begun for one browser does not complete with another flow's binding, but completes with its own.
        const begun = await fixture.Send(F.Get, F.Begin)
        const authorize = new URL(begun.location as string)
        const own = F.CookieValue(begun, F.FlowCookie) as string
        const state = authorize.searchParams.get('state') as string
        assert.equal((await fixture.Callback(state, unbound.flow)).location, F.FailedLocation)
        const second = await fixture.Send(F.Get, F.Begin)
        const secondAuthorize = new URL(second.location as string)
        await fixture.Answer(secondAuthorize.searchParams.get('nonce') as string, F.AppRoles(app, OperatorRoleClaims.Full))
        assert.equal((await fixture.Callback(secondAuthorize.searchParams.get('state') as string, F.CookieValue(second, F.FlowCookie))).location, F.SignedInLocation)
        assert.notEqual(own, F.CookieValue(second, F.FlowCookie))
    })

    it('the break-glass password still signs in and is audited as break-glass, never with its password', async () =>
    {
        const login = await fixture.BreakGlass()
        assert.equal(login.status, 200)
        const session = JSON.parse((await fixture.Send(F.Get, F.Session, F.TokenOf(login))).text) as { claims: Record<string, string[]> }
        assert.deepEqual(session.claims.amr, [OperatorRoleClaims.PasswordMethod])
        await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))
        const audit = await fixture.Audit.Recent(20)
        assert.ok(audit.some(e => e.Actor === BreakGlassOperator.Email && e.Note === 'break-glass' && e.Target === F.Login))
        const written = JSON.stringify(audit)
        for (const secret of [BreakGlassOperator.Password, F.Code, F.ClientSecret, F.TokenOf(login)])
        {
            assert.equal(written.includes(secret), false)
        }
        assert.equal((await fixture.Send(F.Post, F.Login, undefined, JSON.stringify({ email: BreakGlassOperator.Email, password: 'wrong' }))).status, 401)
    })

    it('a staff operator and a break-glass operator with the same email are different actors', async () =>
    {
        const staff = await fixture.SignIn({ ...F.AppRoles(app, OperatorRoleClaims.Full), email: BreakGlassOperator.Email })
        const staffToken = F.TokenOf(staff.reply)
        assert.equal((await fixture.Send(F.Post, F.StaffDisabled, staffToken, JSON.stringify({ principal: 'oidc:none#x', disabled: true }))).status, 404)
        const audit = await fixture.Audit.Recent(20)
        assert.ok(audit.some(e => e.Actor === OperatorRoleClaims.StaffActorOf(BreakGlassOperator.Email) && e.Target === F.StaffDisabled))
        assert.equal(audit.some(e => e.Actor === BreakGlassOperator.Email && e.Target === F.StaffDisabled), false)
    })

    it('the sign-in methods name staff sign-in', async () =>
    {
        const methods = await fixture.Send(F.Get, F.Methods)
        assert.equal(methods.status, 200)
        assert.deepEqual(JSON.parse(methods.text), { staff: true })
    })

    it('a disabled operator in the directory is refused even with the role; enabled again they sign in', async () =>
    {
        const first = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.ReadOnly))
        const staffToken = F.TokenOf(first.reply)
        const adminToken = F.TokenOf(await fixture.BreakGlass())
        const roster = JSON.parse((await fixture.Send(F.Get, F.Staff, adminToken)).text) as StaffOperatorRecord[]
        assert.deepEqual(roster.map(r => r.principal), [fixture.Principal])
        assert.equal((await fixture.Send(F.Post, F.StaffDisabled, adminToken, JSON.stringify({ principal: fixture.Principal, disabled: true }))).status, 200)
        assert.equal((await fixture.Send(F.Get, F.Session, staffToken)).status, 401)
        const again = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))
        assert.equal(again.reply.location, F.ForbiddenLocation)
        assert.equal(F.CookieValue(again.reply, F.SessionCookie), undefined)
        assert.equal((await fixture.Send(F.Post, F.StaffDisabled, adminToken, JSON.stringify({ principal: fixture.Principal, disabled: false }))).status, 200)
        assert.equal((await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))).reply.location, F.SignedInLocation)
    })

    it('the gate refuses a disabled operator\'s session even when it was never revoked', async () =>
    {
        const token = F.TokenOf((await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))).reply)
        // Disabled straight in the directory: no RevokeSubject ran, the session row is still live.
        assert.equal(await fixture.Directory.SetDisabled(fixture.Principal, true), true)
        assert.ok((await fixture.Sessions.Store.Validate(token)) !== null)
        assert.equal((await fixture.Send(F.Get, F.Session, token)).status, 401)
    })

    it('the realm taking the role away ends the live session at the next sign-in attempt', async () =>
    {
        const live = F.TokenOf((await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))).reply)
        const refused = await fixture.SignIn(F.AppRoles(app))
        assert.equal(refused.reply.location, F.ForbiddenLocation)
        assert.equal((await fixture.Send(F.Get, F.Session, live)).status, 401)
        assert.equal((await fixture.Directory.List())[0]?.role, StaffOperatorRole.None)
    })

    it('a staff session absent from the directory, or of another issuer, never authenticates', async () =>
    {
        const unrecorded = await fixture.Sessions.Store.Issue(OperatorRoleClaims.StaffPrincipalOf(fixture.Idp.Issuer, 'never-signed-in'), OperatorRoleClaims.OfStaff(F.Email, StaffOperatorRole.Full))
        assert.equal((await fixture.Send(F.Get, F.Session, unrecorded.Token)).status, 401)
        const foreign = OperatorRoleClaims.StaffPrincipalOf(F.OtherIssuer, F.Subject)
        await fixture.Directory.RecordSignIn(foreign, F.Email, StaffOperatorRole.Full, new Date())
        const other = await fixture.Sessions.Store.Issue(foreign, OperatorRoleClaims.OfStaff(F.Email, StaffOperatorRole.Full))
        assert.equal((await fixture.Send(F.Get, F.Session, other.Token)).status, 401)
    })

    it('the staff roster and its disable switch need operator.full; unknown principals and bad bodies are refused', async () =>
    {
        const readToken = F.TokenOf((await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.ReadOnly))).reply)
        assert.equal((await fixture.Send(F.Get, F.Staff, readToken)).status, 403)
        assert.equal((await fixture.Send(F.Post, F.StaffDisabled, readToken, JSON.stringify({ principal: fixture.Principal, disabled: true }))).status, 403)
        const adminToken = F.TokenOf(await fixture.BreakGlass())
        assert.equal((await fixture.Send(F.Post, F.StaffDisabled, adminToken, JSON.stringify({ principal: 'oidc:https://other#x', disabled: true }))).status, 404)
        assert.equal((await fixture.Send(F.Post, F.StaffDisabled, adminToken, JSON.stringify({ principal: fixture.Principal, disabled: 'yes' }))).status, 400)
    })

    it('a staff operator cannot disable themselves', async () =>
    {
        const token = F.TokenOf((await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))).reply)
        assert.equal((await fixture.Send(F.Post, F.StaffDisabled, token, JSON.stringify({ principal: fixture.Principal, disabled: true }))).status, 409)
        assert.equal((await fixture.Send(F.Get, F.Session, token)).status, 200)
    })

    it('a staff operator has no password here: the own-password change refuses them', async () =>
    {
        const token = F.TokenOf((await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))).reply)
        const change = await fixture.Send(F.Post, F.SessionPassword, token, JSON.stringify({ currentPassword: 'x', newPassword: 'a-new-password-1', confirmPassword: 'a-new-password-1' }))
        assert.equal(change.status, 409)
        assert.match(change.text, /staff realm/)
    })

    it('a refused code exchange lands on the failed sign-in page and logs only the failure class', async () =>
    {
        fixture.Http.FailTokenEndpoint = true
        const { reply } = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))
        assert.equal(reply.location, F.FailedLocation)
        assert.equal(fixture.Logged.length, 1)
        assert.equal(fixture.Logged[0]?.includes(F.Code), false)
    })

    it('begins and callbacks are rate-limited per client address; over the limit the browser lands on the failed page', async () =>
    {
        // 20 a minute: the 21st is refused.
        for (let i = 0; i < 20; i++)
        {
            assert.notEqual((await fixture.Send(F.Get, F.Begin)).location, F.FailedLocation, 'begin ' + i)
        }
        const refused = await fixture.Send(F.Get, F.Begin)
        assert.equal(refused.status, 302)
        assert.equal(refused.location, F.FailedLocation)
        assert.equal(F.CookieValue(refused, F.FlowCookie), undefined)
        assert.equal((await fixture.Callback('any', 'any')).location, F.FailedLocation)
    })

    it('a role the realm took away and gave back never revives the old session', async () =>
    {
        const old = F.TokenOf((await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))).reply)
        assert.equal((await fixture.SignIn(F.AppRoles(app))).reply.location, F.ForbiddenLocation)
        const fresh = F.TokenOf((await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))).reply)
        assert.equal((await fixture.Send(F.Get, F.Session, old)).status, 401)
        assert.equal((await fixture.Send(F.Get, F.Session, fresh)).status, 200)
    })

    it('a store that fails after the code exchange answers the failed page and leaves no session', async () =>
    {
        fixture.Map.FailSaves = true
        const { reply } = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))
        assert.equal(reply.location, F.FailedLocation)
        assert.equal(F.CookieValue(reply, F.SessionCookie), undefined)
        assert.equal(fixture.Logged.length, 1)
    })

    it('break-glass accounts are managed from a break-glass session only', async () =>
    {
        const staff = F.TokenOf((await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))).reply)
        for (const path of [F.Operators, F.Operators + '/disabled', F.Operators + '/password-reset', F.Operators + '/role', F.Operators + '/revoke-sessions'])
        {
            const reply = await fixture.Send(F.Post, path, staff, JSON.stringify({ email: BreakGlassOperator.Email, disabled: true, role: 'readonly', password: 'a-long-password-1' }))
            assert.equal(reply.status, 403, path)
            assert.match(reply.text, /break-glass/)
        }
        const glass = F.TokenOf(await fixture.BreakGlass())
        assert.equal((await fixture.Send(F.Post, F.Operators + '/revoke-sessions', glass, JSON.stringify({ email: 'someone@pragmatic.test' }))).status, 200)
    })
})

describe('operator staff sign-in with the realm unreachable', () =>
{
    const F = StaffSignInFixture
    let fixture: StaffSignInFixture

    beforeEach(async () =>
    {
        fixture = await StaffSignInFixture.Start(RealmMode.Unreachable)
    })

    afterEach(async () =>
    {
        await fixture.Stop()
    })

    it('begin lands on the failed sign-in page, and break-glass still signs in', async () =>
    {
        const begun = await fixture.Send(F.Get, F.Begin)
        assert.equal(begun.status, 302)
        assert.equal(begun.location, F.FailedLocation)
        assert.equal(F.CookieValue(begun, F.FlowCookie), undefined)
        const login = await fixture.BreakGlass()
        assert.equal(login.status, 200)
        assert.equal((await fixture.Send(F.Get, F.Session, F.TokenOf(login))).status, 200)
    })
})

describe('operator staff sign-in off', () =>
{
    const F = StaffSignInFixture
    let fixture: StaffSignInFixture

    beforeEach(async () =>
    {
        fixture = await StaffSignInFixture.Start(RealmMode.Off)
    })

    afterEach(async () =>
    {
        await fixture.Stop()
    })

    it('without the option the OIDC routes are 404, the methods say no staff sign-in, the cookie stays Strict', async () =>
    {
        assert.equal((await fixture.Send(F.Get, F.Begin)).status, 404)
        assert.equal((await fixture.Send(F.Get, F.Callback + '?code=c&state=s')).status, 404)
        assert.deepEqual(JSON.parse((await fixture.Send(F.Get, F.Methods)).text), { staff: false })
        const login = await fixture.BreakGlass()
        assert.equal(login.status, 200)
        assert.ok(login.cookies.some(c => c.startsWith(F.SessionCookie) && /SameSite=Strict/.test(c)))
        assert.deepEqual(JSON.parse((await fixture.Send(F.Get, F.Staff, F.TokenOf(login))).text), [])
    })

    it('a staff session issued while staff sign-in was on no longer authenticates', async () =>
    {
        const issued = await fixture.Sessions.Store.Issue(OperatorRoleClaims.StaffPrincipalOf('https://realm.test', 's'), OperatorRoleClaims.OfStaff(F.Email, StaffOperatorRole.Full))
        assert.equal((await fixture.Send(F.Get, F.Session, issued.Token)).status, 401)
        const directory = new OperatorDirectory(new MemoryRecordMap<StaffOperatorRecord>())
        await directory.RecordSignIn(issued.Session.Subject, F.Email, StaffOperatorRole.Full, new Date())
        // The same session authenticates through a policy for its realm: proof the refusal above is staff sign-in off.
        assert.ok(await new StaffSessionPolicy('https://realm.test', directory).Refreshed(issued.Session) !== null)
    })
})
