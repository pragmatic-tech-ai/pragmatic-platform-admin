import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { EntitledOperation } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CreateTenantRequest, DomainVerificationRequest } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { EntitlementSamples } from '../../entitlements/tests/entitlement-samples.js'
import type { IHiveReservations } from '../client-usage.js'
import { CustomerFixture } from './customer-fixture.js'

class FixedReservations implements IHiveReservations
{
    public constructor(private readonly count: number)
    {
    }

    public OutstandingFor(_clientId: string, _now: Date): number
    {
        return this.count
    }
}

class UsageCases
{
    public static readonly TenantId = 'acme-main'
    public static readonly Domain = 'acme.test'
    public static readonly HiveId = 'acme-hive'
    public static readonly LeftHiveId = 'acme-left'
    public static readonly Generous = { 'tenants': 5, 'hives': 5, 'verified-domains': 5 }
}

describe('ClientUsage', () =>
{
    const S = EntitlementSamples
    const U = UsageCases
    SqlTestSessions.Describe('ClientUsage', (makeSession, backend) =>
    {
        it(`${backend}: counts tenants, hives not gone plus reservations, and held domains`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession(), [new FixedReservations(2)])
            await f.State(S.Statement(1, { Limits: U.Generous }))
            assert.equal(await f.Usage.Of(S.ClientId, EntitledOperation.CreateTenant), 0)
            await f.Service().CreateTenant(S.Admin(), new CreateTenantRequest(S.ClientId, U.TenantId, U.TenantId))
            assert.equal(await f.Usage.Of(S.ClientId, EntitledOperation.CreateTenant), 1)
            await f.Hive(U.HiveId, U.TenantId)
            await f.Hive(U.LeftHiveId, U.TenantId)
            await f.Directory.MarkHiveLeft(U.LeftHiveId)
            assert.equal(await f.Usage.Of(S.ClientId, EntitledOperation.EnrolHive), 1 + 2)
            assert.equal(await f.Usage.Of(S.ClientId, EntitledOperation.VerifyEmailDomain), 0)
            await f.Service().StartDomainVerification(S.Admin(), new DomainVerificationRequest(S.ClientId, U.TenantId, U.Domain))
            assert.equal(await f.Usage.Of(S.ClientId, EntitledOperation.VerifyEmailDomain), 1)
        })
    })
})
