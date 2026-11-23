import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { EntitlementState } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CreateTenantRequest, CustomerApiError, CustomerErrorCode, DomainVerificationRequest, DomainVerificationState, ListTenantsRequest, NotEntitledReason } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { DomainVerificationRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { TxtLookupStatus } from '../../txt-resolver.js'
import { EntitlementSamples } from '../../entitlements/tests/entitlement-samples.js'
import { CustomerFixture } from './customer-fixture.js'

class ServiceCases
{
    public static readonly TenantId = 'acme-main'
    public static readonly OtherTenantId = 'acme-second'
    public static readonly DisplayName = 'Acme main'
    public static readonly Domain = 'acme.test'
    public static readonly OtherDomain = 'acme-two.test'
    public static readonly OtherClient = 'globex'
    public static readonly OtherClientTenant = 'globex-main'
    public static readonly BadTenantId = 'Not_A_Tenant'
    public static readonly Concurrent = 4
    public static readonly TwoTenants = { 'tenants': 2, 'hives': 1, 'verified-domains': 1 }
    public static readonly NoDomains = { 'tenants': 1, 'hives': 1 }

    public static async Refusal(work: Promise<unknown>): Promise<{ code: CustomerErrorCode, reason: NotEntitledReason | undefined }>
    {
        try
        {
            await work
        }
        catch (err)
        {
            assert.ok(err instanceof CustomerApiError, 'a CustomerApiError: ' + String(err))
            return { code: err.CustomerCode, reason: err.Reason }
        }
        assert.fail('expected a refusal')
    }

    public static Create(tenantId: string = ServiceCases.TenantId, clientId: string = EntitlementSamples.ClientId): CreateTenantRequest
    {
        return new CreateTenantRequest(clientId, tenantId, ServiceCases.DisplayName)
    }

    public static Domains(domain: string = ServiceCases.Domain, tenantId: string = ServiceCases.TenantId): DomainVerificationRequest
    {
        return new DomainVerificationRequest(EntitlementSamples.ClientId, tenantId, domain)
    }
}

describe('PlatformCustomerApiService: tenants and domains', () =>
{
    const S = EntitlementSamples
    const C = ServiceCases
    SqlTestSessions.Describe('PlatformCustomerApiService', (makeSession, backend) =>
    {
        it(`${backend}: an unknown client is not-admin-of-client`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            assert.deepEqual(await C.Refusal(f.Service().ListTenants(S.Admin(), new ListTenantsRequest(S.ClientId))), { code: CustomerErrorCode.NotAdminOfClient, reason: undefined })
            assert.deepEqual(await C.Refusal(f.Service().CreateTenant(S.Admin(), C.Create())), { code: CustomerErrorCode.NotAdminOfClient, reason: undefined })
        })

        it(`${backend}: a caller not among the admins is not-admin-of-client`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await f.State(S.Statement(1))
            assert.equal((await C.Refusal(f.Service().ListTenants(CustomerFixture.Stranger, new ListTenantsRequest(S.ClientId)))).code, CustomerErrorCode.NotAdminOfClient)
            assert.equal((await C.Refusal(f.Service().CreateTenant(CustomerFixture.Stranger, C.Create()))).code, CustomerErrorCode.NotAdminOfClient)
        })

        it(`${backend}: creates and lists a tenant`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await f.State(S.Statement(1))
            const view = await f.Service().CreateTenant(S.Admin(), C.Create())
            assert.equal(view.TenantId, C.TenantId)
            assert.equal(view.ClientId, S.ClientId)
            assert.deepEqual((await f.Service().ListTenants(S.Admin(), new ListTenantsRequest(S.ClientId))).map(tenant => tenant.TenantId), [C.TenantId])
            assert.equal((f.Directory.GetTenant(C.TenantId) as { createdBy?: string }).createdBy, S.Admin().Key)
        })

        it(`${backend}: suspended refuses create-tenant and start-domain-verification; list and check pass`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await f.State(S.Statement(1))
            await f.Service().CreateTenant(S.Admin(), C.Create())
            await f.Service().StartDomainVerification(S.Admin(), C.Domains())
            await f.State(S.Statement(2, { State: EntitlementState.Suspended, Limits: { 'tenants': 5, 'hives': 5, 'verified-domains': 5 } }))
            assert.deepEqual(await C.Refusal(f.Service().CreateTenant(S.Admin(), C.Create(C.OtherTenantId))), { code: CustomerErrorCode.NotEntitled, reason: NotEntitledReason.Suspended })
            assert.deepEqual(await C.Refusal(f.Service().StartDomainVerification(S.Admin(), C.Domains(C.OtherDomain))), { code: CustomerErrorCode.NotEntitled, reason: NotEntitledReason.Suspended })
            assert.equal((await f.Service().ListTenants(S.Admin(), new ListTenantsRequest(S.ClientId))).length, 1)
            assert.equal((await f.Service().CheckDomainVerification(S.Admin(), C.Domains())).State, DomainVerificationState.Pending)
        })

        it(`${backend}: a limit the plan does not carry is not-in-plan`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await f.State(S.Statement(1, { Limits: C.NoDomains }))
            await f.Service().CreateTenant(S.Admin(), C.Create())
            assert.deepEqual(await C.Refusal(f.Service().StartDomainVerification(S.Admin(), C.Domains())), { code: CustomerErrorCode.NotEntitled, reason: NotEntitledReason.NotInPlan })
        })

        it(`${backend}: usage at the limit is limit-reached`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await f.State(S.Statement(1))
            await f.Service().CreateTenant(S.Admin(), C.Create())
            assert.deepEqual(await C.Refusal(f.Service().CreateTenant(S.Admin(), C.Create(C.OtherTenantId))), { code: CustomerErrorCode.NotEntitled, reason: NotEntitledReason.LimitReached })
            await f.Service().StartDomainVerification(S.Admin(), C.Domains())
            assert.deepEqual(await C.Refusal(f.Service().StartDomainVerification(S.Admin(), C.Domains(C.OtherDomain))), { code: CustomerErrorCode.NotEntitled, reason: NotEntitledReason.LimitReached })
            // Restarting the domain it holds adds nothing, so it is not refused.
            assert.equal((await f.Service().StartDomainVerification(S.Admin(), C.Domains())).Domain, C.Domain)
        })

        it(`${backend}: four concurrent create-tenant at tenants: 1 land exactly one tenant`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await f.State(S.Statement(1))
            const service = f.Service()
            const outcomes = await Promise.allSettled(Array.from({ length: C.Concurrent }, (_, i) => service.CreateTenant(S.Admin(), C.Create(C.TenantId + i))))
            assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
            assert.equal(f.Directory.ListTenants(S.ClientId).length, 1)
            for (const outcome of outcomes.filter(o => o.status === 'rejected'))
            {
                assert.equal(((outcome as PromiseRejectedResult).reason as CustomerApiError).Reason, NotEntitledReason.LimitReached)
            }
        })

        it(`${backend}: a taken tenant id is tenant-taken`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await f.State(S.Statement(1, { Limits: C.TwoTenants }))
            await f.State(S.Statement(1, { ClientId: C.OtherClient }))
            await f.Service().CreateTenant(S.Admin(), C.Create(C.OtherClientTenant, C.OtherClient))
            assert.equal((await C.Refusal(f.Service().CreateTenant(S.Admin(), C.Create(C.OtherClientTenant)))).code, CustomerErrorCode.TenantTaken)
        })

        it(`${backend}: an invalid tenant id is invalid-request`, async () =>
        {
            assert.throws(() => CreateTenantRequest.Parse({ ClientId: S.ClientId, TenantId: C.BadTenantId, DisplayName: C.DisplayName }), (err: Error & { Code?: string }) => err.message.length > 0)
        })

        it(`${backend}: a tenant of another client is unknown-tenant`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await f.State(S.Statement(1))
            await f.State(S.Statement(1, { ClientId: C.OtherClient }))
            await f.Service().CreateTenant(S.Admin(), C.Create(C.OtherClientTenant, C.OtherClient))
            assert.equal((await C.Refusal(f.Service().StartDomainVerification(S.Admin(), C.Domains(C.Domain, C.OtherClientTenant)))).code, CustomerErrorCode.UnknownTenant)
            assert.equal((await C.Refusal(f.Service().CheckDomainVerification(S.Admin(), C.Domains(C.Domain, C.OtherClientTenant)))).code, CustomerErrorCode.UnknownTenant)
        })

        it(`${backend}: a domain another tenant holds is domain-taken`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await f.State(S.Statement(1))
            await f.State(S.Statement(1, { ClientId: C.OtherClient }))
            await f.Service().CreateTenant(S.Admin(), C.Create())
            await f.Service().CreateTenant(S.Admin(), C.Create(C.OtherClientTenant, C.OtherClient))
            const other = await f.Service().StartDomainVerification(S.Admin(), new DomainVerificationRequest(C.OtherClient, C.OtherClientTenant, C.Domain))
            f.Txt.Answer = { status: TxtLookupStatus.Found, records: [[other.RecordValue]] }
            assert.equal((await f.Service().CheckDomainVerification(S.Admin(), new DomainVerificationRequest(C.OtherClient, C.OtherClientTenant, C.Domain))).State, DomainVerificationState.Verified)
            assert.equal((await C.Refusal(f.Service().StartDomainVerification(S.Admin(), C.Domains()))).code, CustomerErrorCode.DomainTaken)
        })

        it(`${backend}: check answers verified once the TXT record resolves`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await f.State(S.Statement(1))
            await f.Service().CreateTenant(S.Admin(), C.Create())
            const started = await f.Service().StartDomainVerification(S.Admin(), C.Domains())
            assert.equal(started.State, DomainVerificationState.Pending)
            assert.equal(started.RecordName, DomainVerificationRecord.NameFor(C.Domain))
            assert.ok(started.RecordValue.startsWith(DomainVerificationRecord.ValuePrefix))
            assert.equal((await f.Service().CheckDomainVerification(S.Admin(), C.Domains())).State, DomainVerificationState.Pending)
            f.Txt.Answer = { status: TxtLookupStatus.Found, records: [[started.RecordValue]] }
            assert.equal((await f.Service().CheckDomainVerification(S.Admin(), C.Domains())).State, DomainVerificationState.Verified)
        })
    })
})
