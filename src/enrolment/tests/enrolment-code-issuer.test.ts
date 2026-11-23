import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { HiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { MemoryRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { EnrolmentCodeIssuer, EnrolmentCodeRefusal, EnrolmentCodeRefusedError } from '../enrolment-code-issuer.js'
import { EnrolmentAgentKind, EnrolmentCodeRegistry, type EnrolmentCodeRecord } from '../enrolment-code-record.js'

class CodeCases
{
    public static readonly ClientId = 'acme'
    public static readonly TenantA = 'acme-main'
    public static readonly TenantB = 'acme-second'
    public static readonly IssuedBy = 'https://login.example.test/realms/central\nsub-1'
    public static readonly Start = new Date('2026-11-23T12:00:00.000Z')
    public static readonly Expect = { TenantId: CodeCases.TenantA, Level: HiveLevel.Enrolled, AgentKind: EnrolmentAgentKind.Hive }
    public static readonly HashAlgorithm = 'sha256'
    public static readonly HashEncoding = 'hex'

    public static async Issuer(): Promise<{ Issuer: EnrolmentCodeIssuer; Registry: EnrolmentCodeRegistry; Clock: { now: Date } }>
    {
        const registry = new EnrolmentCodeRegistry(new MemoryRecordMap<EnrolmentCodeRecord>())
        await registry.Load()
        const clock = { now: CodeCases.Start }
        return { Issuer: new EnrolmentCodeIssuer(registry, () => clock.now), Registry: registry, Clock: clock }
    }

    public static Issue(issuer: EnrolmentCodeIssuer): Promise<{ Code: string; ExpiresAt: Date }>
    {
        return issuer.Issue({ ClientId: CodeCases.ClientId, TenantId: CodeCases.TenantA, Level: HiveLevel.Enrolled, AgentKind: EnrolmentAgentKind.Hive, IssuedBy: CodeCases.IssuedBy })
    }

    public static async Reason(work: Promise<unknown>): Promise<EnrolmentCodeRefusal>
    {
        try
        {
            await work
        }
        catch (err)
        {
            assert.ok(err instanceof EnrolmentCodeRefusedError)
            return err.Reason
        }
        assert.fail('expected a refusal')
    }
}

describe('EnrolmentCodeIssuer', () =>
{
    const C = CodeCases
    it('a code has the pe1- form and lives 30 minutes', async () =>
    {
        const { Issuer } = await C.Issuer()
        const issued = await C.Issue(Issuer)
        assert.match(issued.Code, EnrolmentCodeIssuer.CodePattern)
        assert.equal(issued.ExpiresAt.getTime() - C.Start.getTime(), 30 * 60 * 1000)
    })

    it('a code redeems once', async () =>
    {
        const { Issuer } = await C.Issuer()
        const { Code } = await C.Issue(Issuer)
        const [first, second] = await Promise.allSettled([Issuer.Redeem(Code, C.Expect), Issuer.Redeem(Code, C.Expect)])
        assert.equal(first.status, 'fulfilled')
        assert.equal(second.status, 'rejected')
        assert.equal(await C.Reason(Issuer.Redeem(Code, C.Expect)), EnrolmentCodeRefusal.Used)
    })

    it('a code for tenant A, level enrolled, agent kind hive redeems for nothing else (and is not consumed)', async () =>
    {
        const { Issuer } = await C.Issuer()
        const { Code } = await C.Issue(Issuer)
        assert.equal(await C.Reason(Issuer.Redeem(Code, { ...C.Expect, TenantId: C.TenantB })), EnrolmentCodeRefusal.Mismatch)
        assert.equal(await C.Reason(Issuer.Redeem(Code, { ...C.Expect, Level: HiveLevel.Delegated })), EnrolmentCodeRefusal.Mismatch)
        assert.equal(await C.Reason(Issuer.Redeem(Code, { ...C.Expect, AgentKind: EnrolmentAgentKind.Host })), EnrolmentCodeRefusal.Mismatch)
        assert.equal((await Issuer.Redeem(Code, C.Expect)).tenantId, C.TenantA)
    })

    it('an unknown or malformed code is unknown', async () =>
    {
        const { Issuer } = await C.Issuer()
        await C.Issue(Issuer)
        assert.equal(await C.Reason(Issuer.Redeem(EnrolmentCodeIssuer.Prefix + 'A'.repeat(26), C.Expect)), EnrolmentCodeRefusal.Unknown)
        assert.equal(await C.Reason(Issuer.Redeem('not a code', C.Expect)), EnrolmentCodeRefusal.Unknown)
    })

    it('an expired code is refused', async () =>
    {
        const { Issuer, Clock } = await C.Issuer()
        const { Code } = await C.Issue(Issuer)
        Clock.now = new Date(C.Start.getTime() + EnrolmentCodeIssuer.LifetimeMs)
        assert.equal(await C.Reason(Issuer.Redeem(Code, C.Expect)), EnrolmentCodeRefusal.Expired)
    })

    it('the stored record holds no code, only its SHA-256', async () =>
    {
        const { Issuer, Registry } = await C.Issuer()
        const { Code } = await C.Issue(Issuer)
        const stored = JSON.stringify(Registry.List())
        assert.ok(!stored.includes(Code))
        assert.ok(!stored.includes(Code.slice(EnrolmentCodeIssuer.Prefix.length)))
        assert.equal(Registry.List()[0]?.id, createHash(C.HashAlgorithm).update(Code).digest(C.HashEncoding))
    })

    it('an outstanding code counts until it is redeemed or expires', async () =>
    {
        const { Issuer, Clock } = await C.Issuer()
        const first = await C.Issue(Issuer)
        await C.Issue(Issuer)
        assert.equal(Issuer.OutstandingFor(C.ClientId, Clock.now), 2)
        await Issuer.Redeem(first.Code, C.Expect)
        assert.equal(Issuer.OutstandingFor(C.ClientId, Clock.now), 1)
        assert.equal(Issuer.OutstandingFor(C.ClientId, new Date(C.Start.getTime() + EnrolmentCodeIssuer.LifetimeMs)), 0)
    })
})
