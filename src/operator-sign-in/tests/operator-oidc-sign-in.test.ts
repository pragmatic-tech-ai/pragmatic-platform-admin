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
import { OperatorRoleClaims, OperatorSessions } from '../../operator-sessions.js'
import type { PlatformDirectory } from '../../platform-directory.js'
import type { PlatformDeploymentRegistry } from '../../platform-deployment-registry.js'
import type { TenantProvisioningService } from '../../tenant-provisioning-service.js'
import type { HiveObservationRegistry } from '../../hive-observation-record.js'
import { OperatorDirectory, type StaffOperatorRecord } from '../operator-directory.js'
import { OperatorOidcSettings } from '../operator-oidc-settings.js'
import { OperatorOidcSignIn } from '../operator-oidc-sign-in.js'

/** One break-glass operator account (password `BreakGlass.Password`), as the console's operator identity would hold it. */
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

type Reply = { status: number; location: string | undefined; cookie: string | undefined; text: string }

/** A console with staff sign-in on (or off) against a fake realm, driven over HTTP like a browser. */
class StaffSignInFixture
{
    public static readonly Loopback = '127.0.0.1'
    public static readonly PublicUrl = 'https://admin.pragmatic.test'
    public static readonly ClientId = 'pragmatic-platform-admin'
    public static readonly ClientSecret = 'operator-client-secret'
    public static readonly Subject = 'account-7'
    public static readonly Email = 'staff@pragmatic.test'
    public static readonly Begin = '/auth/oidc/begin'
    public static readonly Callback = '/auth/oidc/callback'
    public static readonly Session = '/api/session'
    public static readonly Methods = '/api/session/methods'
    public static readonly Login = '/api/login'
    public static readonly SessionPassword = '/api/session/password'
    public static readonly Operators = '/api/operators'
    public static readonly Staff = '/api/operators/staff'
    public static readonly StaffDisabled = '/api/operators/staff/disabled'
    public static readonly Activity = '/api/activity'
    public static readonly SignedInLocation = '/'
    public static readonly ForbiddenLocation = '/?sign_in=forbidden'
    public static readonly FailedLocation = '/?sign_in=failed'
    public static readonly CookieName = 'cp_session='
    public static readonly Get = 'GET'
    public static readonly Post = 'POST'
    public static readonly TempPrefix = 'cp-staff-sign-in-'

    public readonly Root: string
    public readonly Audit = new InMemoryAuditRepository()
    public readonly Directory: OperatorDirectory
    public readonly Map = new MemoryRecordMap<StaffOperatorRecord>()
    public Host!: ControlPlaneHost
    public Idp!: FakeOidcIdp
    public Http!: FakeOidcHttpClient

    public constructor()
    {
        this.Root = mkdtempSync(join(tmpdir(), StaffSignInFixture.TempPrefix))
        this.Directory = new OperatorDirectory(this.Map)
    }

    public static async Start(staffOn: boolean): Promise<StaffSignInFixture>
    {
        const F = new StaffSignInFixture()
        F.Idp = await FakeOidcIdp.Create()
        F.Http = new FakeOidcHttpClient(F.Idp)
        const sessions = new OperatorSessions(OperatorSessions.InMemory(), false)
        const signIn = staffOn ? new OperatorOidcSignIn(F.Settings(), new OidcRelyingParty(new InMemoryOidcFlowStateStore(), { Http: F.Http }), F.Directory, sessions) : undefined
        const service = { ListReconciled: async () => [] } as unknown as IEnvironmentService
        F.Host = new ControlPlaneHost({ Service: service, Graphs: {} as IGraphService, PortalRoot: F.Root, Operator: new BreakGlassOperator(), Sessions: sessions,
            Directory: {} as PlatformDirectory, Deployments: {} as PlatformDeploymentRegistry, Provisioning: {} as TenantProvisioningService, Observations: {} as HiveObservationRegistry,
            Audit: F.Audit, OperatorSignIn: signIn, StaffOperators: staffOn ? F.Directory : undefined })
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

    /** Begins a sign-in and lets the realm answer the code exchange with an id token carrying `claims`; answers the
     *  callback's reply and the authorize URL the begin redirected to. */
    public async SignIn(claims: Record<string, unknown>, nonce?: string): Promise<{ reply: Reply; authorize: URL }>
    {
        const begun = await this.Send(StaffSignInFixture.Get, StaffSignInFixture.Begin)
        const authorize = new URL(begun.location as string)
        await this.Answer(nonce ?? authorize.searchParams.get('nonce') as string, claims)
        const reply = await this.Send(StaffSignInFixture.Get, StaffSignInFixture.Callback + '?code=the-code&state=' + encodeURIComponent(authorize.searchParams.get('state') as string))
        return { reply, authorize }
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

    public static TokenOf(reply: Reply): string
    {
        const cookie = reply.cookie ?? ''
        assert.ok(cookie.startsWith(StaffSignInFixture.CookieName), cookie)
        return cookie.slice(StaffSignInFixture.CookieName.length).split(';')[0] as string
    }

    public Send(method: string, path: string, token?: string, body?: string): Promise<Reply>
    {
        const addr = this.Host.Address()
        return new Promise((resolve, reject) =>
        {
            const headers: Record<string, string> = { 'content-type': 'application/json' }
            if (token !== undefined)
            {
                headers.cookie = StaffSignInFixture.CookieName + token
            }
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                let text = ''
                res.on('data', (c: Buffer) => { text += c.toString() })
                res.on('end', () =>
                {
                    const setCookie = res.headers['set-cookie']
                    resolve({ status: res.statusCode ?? 0, location: res.headers.location, cookie: setCookie?.[0], text })
                })
            })
            req.on('error', reject)
            req.end(body)
        })
    }

    private Settings(): OperatorOidcSettings
    {
        const secretFile = join(this.Root, 'client-secret')
        writeFileSync(secretFile, StaffSignInFixture.ClientSecret + '\n')
        const settings = OperatorOidcSettings.Of({
            [OperatorOidcSettings.IssuerEnvVar]: this.Idp.Issuer,
            [OperatorOidcSettings.DiscoveryUrlEnvVar]: this.Idp.DiscoveryUrl,
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
        fixture = await StaffSignInFixture.Start(true)
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
        assert.match(reply.cookie ?? '', /SameSite=Lax/)
        const token = F.TokenOf(reply)
        const session = JSON.parse((await fixture.Send(F.Get, F.Session, token)).text) as { subject: string; claims: Record<string, string[]> }
        assert.equal(session.subject, fixture.Principal)
        assert.deepEqual(session.claims.app_roles, [OperatorRoleClaims.Full])
        assert.deepEqual(session.claims.amr, [OperatorRoleClaims.StaffMethod])
        assert.deepEqual(session.claims.email, [F.Email])
        assert.equal((await fixture.Send(F.Get, F.Operators, token)).status, 200)
        const recorded = await fixture.Directory.List()
        assert.deepEqual(recorded.map(r => [r.principal, r.email, r.role, r.method, r.disabled]), [[fixture.Principal, F.Email, OperatorRoleClaims.Full, 'staff', false]])
        const audit = await fixture.Audit.Recent(10)
        assert.ok(audit.some(e => e.Actor === F.Email && e.Note === 'staff' && e.Status === 200))
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
        assert.equal(reply.cookie, undefined)
        assert.deepEqual(await fixture.Directory.List(), [])
        const audit = await fixture.Audit.Recent(10)
        assert.ok(audit.some(e => e.Actor === F.Email && e.Status === 403 && (e.Note ?? '').includes('no-operator-role')))
    })

    it('roles of another application are ignored', async () =>
    {
        const { reply } = await fixture.SignIn({ app_roles: { 'pragmatic-ledger': [OperatorRoleClaims.Full], other: [OperatorRoleClaims.ReadOnly] }, roles: [OperatorRoleClaims.Full] })
        assert.equal(reply.location, F.ForbiddenLocation)
        assert.equal(reply.cookie, undefined)
    })

    it('state, nonce and PKCE are checked', async () =>
    {
        const wrongNonce = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full), 'not-the-nonce')
        assert.equal(wrongNonce.reply.location, F.FailedLocation)
        assert.equal(wrongNonce.reply.cookie, undefined)
        // The state was consumed by the failed attempt: replaying it fails too, even with a good token.
        const state = wrongNonce.authorize.searchParams.get('state') as string
        await fixture.Answer(wrongNonce.authorize.searchParams.get('nonce') as string, F.AppRoles(app, OperatorRoleClaims.Full))
        const replay = await fixture.Send(F.Get, F.Callback + '?code=c&state=' + encodeURIComponent(state))
        assert.equal(replay.location, F.FailedLocation)
        const unknown = await fixture.Send(F.Get, F.Callback + '?code=c&state=never-issued')
        assert.equal(unknown.location, F.FailedLocation)
        const missing = await fixture.Send(F.Get, F.Callback + '?state=' + encodeURIComponent(state))
        assert.equal(missing.location, F.FailedLocation)
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

    it('the break-glass password still signs in and is audited as break-glass', async () =>
    {
        const login = await fixture.Send(F.Post, F.Login, undefined, JSON.stringify({ email: BreakGlassOperator.Email, password: BreakGlassOperator.Password }))
        assert.equal(login.status, 200)
        const session = JSON.parse((await fixture.Send(F.Get, F.Session, F.TokenOf(login))).text) as { claims: Record<string, string[]> }
        assert.deepEqual(session.claims.amr, [OperatorRoleClaims.PasswordMethod])
        const audit = await fixture.Audit.Recent(10)
        assert.ok(audit.some(e => e.Actor === BreakGlassOperator.Email && e.Note === 'break-glass' && e.Target === F.Login))
        const wrong = await fixture.Send(F.Post, F.Login, undefined, JSON.stringify({ email: BreakGlassOperator.Email, password: 'wrong' }))
        assert.equal(wrong.status, 401)
    })

    it('the sign-in methods name staff sign-in', async () =>
    {
        const methods = await fixture.Send(F.Get, F.Methods)
        assert.equal(methods.status, 200)
        assert.deepEqual(JSON.parse(methods.text), { staff: true })
    })

    it('a disabled operator in the directory is refused even with the role', async () =>
    {
        const first = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.ReadOnly))
        const staffToken = F.TokenOf(first.reply)
        const login = await fixture.Send(F.Post, F.Login, undefined, JSON.stringify({ email: BreakGlassOperator.Email, password: BreakGlassOperator.Password }))
        const adminToken = F.TokenOf(login)
        const roster = JSON.parse((await fixture.Send(F.Get, F.Staff, adminToken)).text) as StaffOperatorRecord[]
        assert.deepEqual(roster.map(r => r.principal), [fixture.Principal])
        const disabled = await fixture.Send(F.Post, F.StaffDisabled, adminToken, JSON.stringify({ principal: fixture.Principal, disabled: true }))
        assert.equal(disabled.status, 200)
        // The live session ends at once, and the next sign-in is refused although the realm still gives the role.
        assert.equal((await fixture.Send(F.Get, F.Session, staffToken)).status, 401)
        const again = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))
        assert.equal(again.reply.location, F.ForbiddenLocation)
        assert.equal(again.reply.cookie, undefined)
        // Enabled again: the next sign-in works.
        assert.equal((await fixture.Send(F.Post, F.StaffDisabled, adminToken, JSON.stringify({ principal: fixture.Principal, disabled: false }))).status, 200)
        assert.equal((await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))).reply.location, F.SignedInLocation)
    })

    it('the staff roster and its disable switch need operator.full; unknown principals and bad bodies are refused', async () =>
    {
        const staff = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.ReadOnly))
        const readToken = F.TokenOf(staff.reply)
        assert.equal((await fixture.Send(F.Get, F.Staff, readToken)).status, 403)
        assert.equal((await fixture.Send(F.Post, F.StaffDisabled, readToken, JSON.stringify({ principal: fixture.Principal, disabled: true }))).status, 403)
        const adminToken = F.TokenOf(await fixture.Send(F.Post, F.Login, undefined, JSON.stringify({ email: BreakGlassOperator.Email, password: BreakGlassOperator.Password })))
        assert.equal((await fixture.Send(F.Post, F.StaffDisabled, adminToken, JSON.stringify({ principal: 'oidc:https://other#x', disabled: true }))).status, 404)
        assert.equal((await fixture.Send(F.Post, F.StaffDisabled, adminToken, JSON.stringify({ principal: fixture.Principal, disabled: 'yes' }))).status, 400)
    })

    it('a staff operator has no password here: the own-password change refuses them', async () =>
    {
        const { reply } = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))
        const change = await fixture.Send(F.Post, F.SessionPassword, F.TokenOf(reply), JSON.stringify({ currentPassword: 'x', newPassword: 'a-new-password-1', confirmPassword: 'a-new-password-1' }))
        assert.equal(change.status, 409)
        assert.match(change.text, /staff realm/)
    })

    it('a staff operator cannot disable themselves', async () =>
    {
        const { reply } = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))
        const token = F.TokenOf(reply)
        const self = await fixture.Send(F.Post, F.StaffDisabled, token, JSON.stringify({ principal: fixture.Principal, disabled: true }))
        assert.equal(self.status, 409)
        assert.equal((await fixture.Send(F.Get, F.Session, token)).status, 200)
    })

    it('a refused code exchange lands on the failed sign-in page', async () =>
    {
        fixture.Http.FailTokenEndpoint = true
        const { reply } = await fixture.SignIn(F.AppRoles(app, OperatorRoleClaims.Full))
        assert.equal(reply.location, F.FailedLocation)
    })
})

describe('operator staff sign-in off', () =>
{
    const F = StaffSignInFixture
    let fixture: StaffSignInFixture

    beforeEach(async () =>
    {
        fixture = await StaffSignInFixture.Start(false)
    })

    afterEach(async () =>
    {
        await fixture.Stop()
    })

    it('without the option the OIDC routes are 404 and the methods say no staff sign-in', async () =>
    {
        assert.equal((await fixture.Send(F.Get, F.Begin)).status, 404)
        assert.equal((await fixture.Send(F.Get, F.Callback + '?code=c&state=s')).status, 404)
        assert.deepEqual(JSON.parse((await fixture.Send(F.Get, F.Methods)).text), { staff: false })
        const login = await fixture.Send(F.Post, F.Login, undefined, JSON.stringify({ email: BreakGlassOperator.Email, password: BreakGlassOperator.Password }))
        assert.equal(login.status, 200)
        const roster = await fixture.Send(F.Get, F.Staff, F.TokenOf(login))
        assert.deepEqual(JSON.parse(roster.text), [])
    })

    it('a staff session issued while staff sign-in was on no longer authenticates', async () =>
    {
        const sessions = new OperatorSessions(OperatorSessions.InMemory(), false)
        const issued = await sessions.Store.Issue(OperatorRoleClaims.StaffPrincipalOf('https://realm.test', 's'), OperatorRoleClaims.OfStaff(F.Email, [OperatorRoleClaims.Full]))
        const gate = sessions.GateOver(new BreakGlassOperator())
        assert.equal(await gate.Refreshed(issued.Session), null)
    })
})
