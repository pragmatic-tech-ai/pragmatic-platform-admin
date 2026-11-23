import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { SessionClaims } from '@pragmatic-tech-ai/pragmatic-app-host'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSummary } from '../operator-identity.js'
import { OperatorPasswordAuthenticator, OperatorRoleClaims, OperatorSessions } from '../operator-sessions.js'
import type { IStaffOperatorStanding } from '../operator-sign-in/operator-directory.js'

/** An operator directory whose principals a test edits between requests. */
class LiveOperators implements IOperatorIdentity
{
    public static readonly Email = 'op@example.com'
    public static readonly Password = 'correct-horse-battery'
    public readonly Principals = new Map<string, OperatorPrincipal>()

    public async Verify(email: string, password: string): Promise<OperatorPrincipal | null>
    {
        const found = [...this.Principals.values()].find(p => p.email === email)
        return found !== undefined && password === LiveOperators.Password ? found : null
    }

    public async PrincipalOf(principalId: string): Promise<OperatorPrincipal | null>
    {
        return this.Principals.get(principalId) ?? null
    }

    public async CreateOperator(): Promise<void> { }
    public async ListOperators(): Promise<readonly OperatorSummary[]> { return [] }
    public async SetOperatorRole(): Promise<void> { }
    public async ResetOperatorPassword(): Promise<string> { return '' }
    public async ChangeOwnPassword(): Promise<boolean> { return false }
    public async SetOperatorDisabled(): Promise<void> { }
    public async RevokeOperatorSessions(): Promise<void> { }
}

/** A staff standing a test flips: every staff principal is disabled or none is. */
class FixedStanding implements IStaffOperatorStanding
{
    public Disabled = false

    public async IsDisabled(): Promise<boolean>
    {
        return this.Disabled
    }
}

class SessionFixture
{
    public static Request(cookie: string): IncomingMessage
    {
        return { headers: { cookie } } as unknown as IncomingMessage
    }
}

describe('OperatorRoleClaims', () =>
{
    it('carries the email and the console role in app_roles, and reads them back (ReadOnly unless Full)', () =>
    {
        const full = OperatorRoleClaims.Of({ email: LiveOperators.Email, principalId: 'p1', role: OperatorRole.Full })
        assert.deepEqual(full.ToJson(), { email: [LiveOperators.Email], app_roles: ['operator.full'], amr: ['pwd'] })
        const ro = OperatorRoleClaims.Of({ email: LiveOperators.Email, principalId: 'p1', role: OperatorRole.ReadOnly })
        assert.deepEqual(ro.Values('app_roles'), ['operator.read-only'])
        assert.deepEqual(OperatorRoleClaims.Any, ['operator.full', 'operator.read-only'])
    })
})

describe('OperatorSessions', () =>
{
    it('issues the cp_session cookie (Secure as configured) for one hour, fixed', async () =>
    {
        const sessions = new OperatorSessions(OperatorSessions.InMemory(), true)
        const issued = await sessions.Store.Issue('p1', OperatorRoleClaims.Of({ email: LiveOperators.Email, principalId: 'p1', role: OperatorRole.Full }))
        const cookie = sessions.Cookie.Build(issued.Token, issued.Session.ExpiresAt)
        assert.ok(cookie.startsWith('cp_session='))
        assert.ok(cookie.includes('Secure'))
        assert.equal(issued.Session.ExpiresAt.getTime() - issued.Session.IssuedAt.getTime(), OperatorSessions.TtlMs)
        assert.equal(issued.Session.Policy.Slides, false)
    })

    it('the gate refreshes the role claim from the account on every request, and refuses a gone or disabled operator', async () =>
    {
        const operators = new LiveOperators()
        operators.Principals.set('p1', { email: LiveOperators.Email, principalId: 'p1', role: OperatorRole.Full })
        const sessions = new OperatorSessions(OperatorSessions.InMemory(), false)
        const gate = sessions.GateOver(operators)
        const issued = await sessions.Store.Issue('p1', OperatorRoleClaims.Of(operators.Principals.get('p1') as OperatorPrincipal))
        const request = SessionFixture.Request(`cp_session=${issued.Token}`)
        assert.deepEqual((await gate.Current(request))?.Claims.Values('app_roles'), ['operator.full'])
        operators.Principals.set('p1', { email: LiveOperators.Email, principalId: 'p1', role: OperatorRole.ReadOnly })
        assert.deepEqual((await gate.Current(request))?.Claims.Values('app_roles'), ['operator.read-only'])
        operators.Principals.delete('p1')
        assert.equal(await gate.Current(request), null)
        assert.equal(await gate.Current(SessionFixture.Request('cp_session=unknown')), null)
    })

    it('a staff session (oidc method, oidc: principal) keeps its issued claims while its operator is not disabled', async () =>
    {
        const operators = new LiveOperators()
        const sessions = new OperatorSessions(OperatorSessions.InMemory(), false)
        const standing = new FixedStanding()
        const gate = sessions.GateOver(operators, standing)
        const realmClaims = OperatorRoleClaims.OfStaff('sso@example.com', [OperatorRoleClaims.ReadOnly])
        const issued = await sessions.Store.Issue(OperatorRoleClaims.StaffPrincipalOf('https://realm.example/realms/r', 'sub-1'), realmClaims)
        const current = await gate.Current(SessionFixture.Request(`cp_session=${issued.Token}`))
        assert.deepEqual(current?.Claims.ToJson(), { email: ['sso@example.com'], app_roles: ['operator.read-only'], amr: ['oidc'] })
        standing.Disabled = true
        assert.equal(await gate.Current(SessionFixture.Request(`cp_session=${issued.Token}`)), null)
    })

    it('a session of no known shape (neither pwd nor a staff principal) never authenticates', async () =>
    {
        const operators = new LiveOperators()
        const sessions = new OperatorSessions(OperatorSessions.InMemory(), false)
        const gate = sessions.GateOver(operators, new FixedStanding())
        const forged = await sessions.Store.Issue('realm-subject', SessionClaims.From({ email: 'sso@example.com', app_roles: ['operator.full'], amr: ['oidc'] }))
        assert.equal(await gate.Current(SessionFixture.Request(`cp_session=${forged.Token}`)), null)
        const bare = await sessions.Store.Issue('someone', SessionClaims.From({ email: 'x@example.com', app_roles: ['operator.full'] }))
        assert.equal(await gate.Current(SessionFixture.Request(`cp_session=${bare.Token}`)), null)
    })

    it('a session of the co-hosted tenant plane (it names its tenant) never authenticates an operator, whatever its roles', async () =>
    {
        const operators = new LiveOperators()
        const sessions = new OperatorSessions(OperatorSessions.InMemory(), false)
        const gate = sessions.GateOver(operators)
        const tenantClaims = SessionClaims.From({ tenant: 'acme', email: 'ann@acme.test', app_roles: ['operator.full'], amr: ['pwd'] })
        const issued = await sessions.Store.Issue('ann', tenantClaims)
        assert.equal(await gate.Current(SessionFixture.Request(`cp_session=${issued.Token}`)), null)
    })
})

describe('OperatorPasswordAuthenticator', () =>
{
    it('answers the operator as subject and claims for the right password, null otherwise', async () =>
    {
        const operators = new LiveOperators()
        operators.Principals.set('p1', { email: LiveOperators.Email, principalId: 'p1', role: OperatorRole.ReadOnly })
        const authenticator = new OperatorPasswordAuthenticator(operators)
        const identity = await authenticator.Authenticate(LiveOperators.Email, LiveOperators.Password)
        assert.equal(identity?.Subject, 'p1')
        assert.deepEqual(identity?.Claims.ToJson(), { email: [LiveOperators.Email], app_roles: ['operator.read-only'], amr: ['pwd'] })
        assert.equal(await authenticator.Authenticate(LiveOperators.Email, 'wrong'), null)
    })
})
