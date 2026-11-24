import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { CentralLoginSubject, EntitlementState } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CreateTenantRequest, CustomerApiError, CustomerErrorCode, HiveHealth, HiveLevel, LeaveHiveRequest, ListHivesRequest, NotEntitledReason, RequestEnvironmentRequest, RequestedEnvironmentPurpose, StartEnrolmentRequest } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { CreateEnvironment, Intent, SignedEnvelope } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { IntentPublisher } from '../../intents/intent-publisher.js'
import { EntitlementSamples } from '../../entitlements/tests/entitlement-samples.js'
import { EnrolmentCodeIssuer } from '../../enrolment/enrolment-code-issuer.js'
import { EnrolmentAgentKind } from '../../enrolment/enrolment-code-record.js'
import { EngineInstallCommand } from '../../enrolment/engine-install-command.js'
import { PlacementState } from '../../placement/placement-record.js'
import { PlacementFailure } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { CustomerFixture, FakeDeployments } from './customer-fixture.js'

class HiveCases
{
    public static readonly TenantId = 'acme-main'
    public static readonly OtherClient = 'globex'
    public static readonly OtherTenant = 'globex-main'
    public static readonly HiveId = 'acme-hive'
    public static readonly OtherHive = 'globex-hive'
    public static readonly ConsoleUrl = 'https://console.acme.test'
    public static readonly AdvertDomain = 'acme.test'
    public static readonly TwoHives = { 'tenants': 1, 'hives': 2, 'verified-domains': 1 }
    public static readonly StillPlaced = ': cluster still placed'
    public static readonly BadRelease = 'latest; rm -rf /'

    public static async Ready(f: CustomerFixture, limits?: Record<string, number>): Promise<void>
    {
        await f.State(EntitlementSamples.Statement(1, limits === undefined ? {} : { Limits: limits }))
        await f.Service().CreateTenant(EntitlementSamples.Admin(), new CreateTenantRequest(EntitlementSamples.ClientId, HiveCases.TenantId, HiveCases.TenantId))
    }

    public static Start(level: HiveLevel): StartEnrolmentRequest
    {
        return new StartEnrolmentRequest(EntitlementSamples.ClientId, HiveCases.TenantId, level)
    }

    public static async Code(work: Promise<unknown>): Promise<{ code: CustomerErrorCode, reason: NotEntitledReason | undefined }>
    {
        try
        {
            await work
        }
        catch (err)
        {
            assert.ok(err instanceof CustomerApiError, String(err))
            return { code: err.CustomerCode, reason: err.Reason }
        }
        assert.fail('expected a refusal')
    }
}

describe('PlatformCustomerApiService: enrolment, hives, leave', () =>
{
    const S = EntitlementSamples
    const C = HiveCases
    SqlTestSessions.Describe('PlatformCustomerApiService hives', (makeSession, backend) =>
    {
        it(`${backend}: standalone answers the install command only, recording and counting nothing`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f)
            const start = await f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Standalone))
            assert.deepEqual(start.ToJson(), { Level: HiveLevel.Standalone, InstallCommand: EngineInstallCommand.For(HiveLevel.Standalone, FakeDeployments.Release, C.TenantId), EnrolmentCode: null, ExpiresAt: null, PlacementId: null })
            assert.equal(f.Codes.OutstandingFor(S.ClientId, f.Clock.Now()), 0)
            assert.equal(f.Placements.OpenFor(S.ClientId).length, 0)
        })

        it(`${backend}: enrolled answers the command and a one-time code that redeems for the tenant`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f)
            const start = await f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Enrolled))
            assert.equal(start.InstallCommand, EngineInstallCommand.For(HiveLevel.Enrolled, FakeDeployments.Release, C.TenantId))
            assert.match(start.EnrolmentCode ?? '', EnrolmentCodeIssuer.CodePattern)
            assert.ok(!(start.InstallCommand ?? '').includes(start.EnrolmentCode ?? '-'))
            assert.equal((start.ExpiresAt as Date).getTime() - f.Clock.Now().getTime(), EnrolmentCodeIssuer.LifetimeMs)
            const redeemed = await f.Codes.Redeem(start.EnrolmentCode as string, { TenantId: C.TenantId, Level: HiveLevel.Enrolled, AgentKind: EnrolmentAgentKind.Hive })
            assert.equal(redeemed.issuedBy, S.Admin().Key)
        })

        it(`${backend}: start-enrolment hosted answers a placement id and records a requested placement`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f)
            const start = await f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Hosted))
            const open = f.Placements.OpenFor(S.ClientId)
            assert.equal(open.length, 1)
            assert.equal(open[0]?.id, start.PlacementId)
            assert.equal(open[0]?.state, PlacementState.Requested)
            const hives = await f.Service().ListHives(S.Admin(), new ListHivesRequest(S.ClientId))
            assert.deepEqual(hives.map(h => [h.HiveId, h.Level, h.Health]), [[start.PlacementId, HiveLevel.Hosted, HiveHealth.Pending]])
        })

        it(`${backend}: an outstanding code counts against hives`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f)
            await f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Delegated))
            assert.deepEqual(await C.Code(f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Enrolled))), { code: CustomerErrorCode.NotEntitled, reason: NotEntitledReason.LimitReached })
            assert.deepEqual(await C.Code(f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Hosted))), { code: CustomerErrorCode.NotEntitled, reason: NotEntitledReason.LimitReached })
            f.Clock.Advance(EnrolmentCodeIssuer.LifetimeMs)
            assert.ok((await f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Hosted))).PlacementId !== null)
        })

        it(`${backend}: suspended refuses enrolment but standalone, list and leave pass`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f)
            await f.Hive(C.HiveId, C.TenantId)
            await f.State(S.Statement(2, { State: EntitlementState.Suspended }))
            assert.deepEqual(await C.Code(f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Enrolled))), { code: CustomerErrorCode.NotEntitled, reason: NotEntitledReason.Suspended })
            assert.ok((await f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Standalone))).InstallCommand !== null)
            assert.equal((await f.Service().ListHives(S.Admin(), new ListHivesRequest(S.ClientId))).length, 1)
            assert.equal((await f.Service().LeaveHive(S.Admin(), new LeaveHiveRequest(S.ClientId, C.HiveId))).Health, HiveHealth.Gone)
        })

        it(`${backend}: no admitted release is unavailable`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f)
            f.Deployments.Release = undefined
            assert.equal((await C.Code(f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Standalone)))).code, CustomerErrorCode.Unavailable)
        })

        it(`${backend}: leave-hive marks the hive gone, releases its console domain claims and stops counting it`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f)
            await f.Hive(C.HiveId, C.TenantId)
            await f.Adverts.Report({ tenantId: C.TenantId, hiveId: C.HiveId, consoleUrl: C.ConsoleUrl, fingerprints: [], emailDomains: [C.AdvertDomain], reportedAt: f.Clock.Now().toISOString() })
            assert.deepEqual(await C.Code(f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Hosted))), { code: CustomerErrorCode.NotEntitled, reason: NotEntitledReason.LimitReached })
            const view = await f.Service().LeaveHive(S.Admin(), new LeaveHiveRequest(S.ClientId, C.HiveId))
            assert.equal(view.Health, HiveHealth.Gone)
            assert.ok(f.Directory.GetHive(C.HiveId) !== undefined, 'the record is kept')
            assert.equal(f.Adverts.ForTenant(C.TenantId), undefined)
            assert.deepEqual(f.Deployments.Deregistered, [C.HiveId])
            assert.ok((await f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Hosted))).PlacementId !== null)
            assert.equal((await f.Service().LeaveHive(S.Admin(), new LeaveHiveRequest(S.ClientId, C.HiveId))).Health, HiveHealth.Gone)
        })

        it(`${backend}: leaving an open placement withdraws it: gone, off the list, no longer counted`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f)
            const placement = (await f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Hosted))).PlacementId as string
            assert.equal((await C.Code(f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Hosted)))).reason, NotEntitledReason.LimitReached)
            const view = await f.Service().LeaveHive(S.Admin(), new LeaveHiveRequest(S.ClientId, placement))
            assert.deepEqual([view.HiveId, view.Level, view.Health], [placement, HiveLevel.Hosted, HiveHealth.Gone])
            assert.deepEqual(await f.Service().ListHives(S.Admin(), new ListHivesRequest(S.ClientId)), [])
            assert.ok((await f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Hosted))).PlacementId !== null, 'the slot is free again')
            assert.equal((await C.Code(f.Service().LeaveHive(S.Admin(), new LeaveHiveRequest(S.ClientId, placement)))).code, CustomerErrorCode.UnknownHive)
        })

        it(`${backend}: leaving a Hosted hive records one operator activity entry: its cluster is still placed`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f)
            await f.Hive(C.HiveId, C.TenantId)
            await f.Service().LeaveHive(S.Admin(), new LeaveHiveRequest(S.ClientId, C.HiveId))
            await f.Service().LeaveHive(S.Admin(), new LeaveHiveRequest(S.ClientId, C.HiveId))
            assert.equal(f.Activity.Entries.length, 1)
            assert.equal(f.Activity.Entries[0]?.actor, S.Admin().Email)
            assert.match(f.Activity.Entries[0]?.note ?? '', new RegExp(C.HiveId + C.StillPlaced))
        })

        it(`${backend}: leaving a hive a host placed publishes its removal (no activity entry); leaving a scheduled placement removes it too`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f, C.TwoHives)
            const schedule = { HostId: 'hsaaaaaaaaaa', Label: C.TenantId + '-abcd', HiveHostName: C.TenantId + '-abcd.hives.pragmatic-tech.ai', EngineVersion: FakeDeployments.Release, ChartDigest: 'sha256:' + 'a'.repeat(64) }
            const placed = await f.Placements.Request(S.ClientId, C.TenantId, S.Admin().Key)
            await f.Placements.Schedule(placed.id, schedule)
            await f.Placements.MarkPlaced(placed.id, { host: 'hive-laptop.mesh.test', port: 16444 })
            await f.Hive(C.HiveId, C.TenantId)
            await f.Placements.LinkHive(placed.id, C.HiveId)
            assert.equal(f.Placements.OutstandingFor(S.ClientId, new Date()), 0, 'its hive counts instead')
            const left = await f.Service().LeaveHive(S.Admin(), new LeaveHiveRequest(S.ClientId, C.HiveId))
            assert.equal(left.Health, HiveHealth.Gone)
            assert.equal(f.Placements.Get(placed.id)?.state, PlacementState.Removing)
            assert.equal(f.Placements.Get(placed.id)?.requestSequence, undefined, 'the removal is owed to the host')
            assert.equal(f.Activity.Entries.length, 0)
            const scheduled = await f.Placements.Request(S.ClientId, C.TenantId, S.Admin().Key)
            await f.Placements.Schedule(scheduled.id, { ...schedule, Label: C.TenantId + '-efgh', HiveHostName: C.TenantId + '-efgh.hives.pragmatic-tech.ai' })
            const view = await f.Service().LeaveHive(S.Admin(), new LeaveHiveRequest(S.ClientId, scheduled.id))
            assert.equal(view.Health, HiveHealth.Gone)
            assert.equal(f.Placements.Get(scheduled.id)?.state, PlacementState.Removing)
        })

        it(`${backend}: a placement its host could not place shows degraded, no longer counts, and leaving removes it`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f)
            const placement = (await f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Hosted))).PlacementId as string
            await f.Placements.Schedule(placement, { HostId: 'hsaaaaaaaaaa', Label: C.TenantId + '-abcd', HiveHostName: C.TenantId + '-abcd.hives.pragmatic-tech.ai', EngineVersion: FakeDeployments.Release, ChartDigest: 'sha256:' + 'a'.repeat(64) })
            await f.Placements.MarkFailed(placement, PlacementFailure.ClusterCreateFailed)
            const hives = await f.Service().ListHives(S.Admin(), new ListHivesRequest(S.ClientId))
            assert.deepEqual(hives.map(h => [h.HiveId, h.Health]), [[placement, HiveHealth.Degraded]])
            assert.equal(f.Placements.OutstandingFor(S.ClientId, new Date()), 0)
            await f.Service().LeaveHive(S.Admin(), new LeaveHiveRequest(S.ClientId, placement))
            assert.equal(f.Placements.Get(placement)?.state, PlacementState.Removing)
        })

        it(`${backend}: an install release that is not a version is unavailable`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f)
            f.Deployments.Release = C.BadRelease
            assert.equal((await C.Code(f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Standalone)))).code, CustomerErrorCode.Unavailable)
            assert.equal((await C.Code(f.Service().StartEnrolment(S.Admin(), C.Start(HiveLevel.Enrolled)))).code, CustomerErrorCode.Unavailable)
        })

        it(`${backend}: a hive of another client, or none, is unknown-hive; a tenant of another client is unknown-tenant`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f, C.TwoHives)
            await f.State(S.Statement(1, { ClientId: C.OtherClient }))
            await f.Service().CreateTenant(S.Admin(), new CreateTenantRequest(C.OtherClient, C.OtherTenant, C.OtherTenant))
            await f.Hive(C.OtherHive, C.OtherTenant)
            assert.equal((await C.Code(f.Service().LeaveHive(S.Admin(), new LeaveHiveRequest(S.ClientId, C.OtherHive)))).code, CustomerErrorCode.UnknownHive)
            assert.equal((await C.Code(f.Service().LeaveHive(S.Admin(), new LeaveHiveRequest(S.ClientId, C.HiveId)))).code, CustomerErrorCode.UnknownHive)
            assert.equal((await C.Code(f.Service().ListHives(S.Admin(), new ListHivesRequest(S.ClientId, C.OtherTenant)))).code, CustomerErrorCode.UnknownTenant)
            assert.equal((await C.Code(f.Service().StartEnrolment(S.Admin(), new StartEnrolmentRequest(S.ClientId, C.OtherTenant, HiveLevel.Hosted)))).code, CustomerErrorCode.UnknownTenant)
        })

        it(`${backend}: request-environment records a create-environment intent at the hive's level for its customer admin`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f)
            await f.EnrolledHive(C.HiveId, C.TenantId, HiveLevel.Delegated)
            const answer = await f.Service().RequestEnvironment(S.Admin(), new RequestEnvironmentRequest(S.ClientId, C.HiveId, 'prod', RequestedEnvironmentPurpose.Runtime))
            assert.match(answer.IntentId, /^in[a-z2-7]{12}$/)
            assert.equal(answer.Level, HiveLevel.Delegated)
            const record = f.Intents.Get(answer.IntentId)
            assert.equal(record?.publishedBy, 'customer:' + S.Admin().Key)
            const action = Intent.Parse(SignedEnvelope.Decode(record?.envelope as string).Body).Action as CreateEnvironment
            assert.deepEqual([action.Environment, action.Purpose, action.Version], ['prod', 'runtime', null])
            const again = await f.Service().RequestEnvironment(S.Admin(), new RequestEnvironmentRequest(S.ClientId, C.HiveId, 'prod', RequestedEnvironmentPurpose.Runtime))
            assert.equal(again.IntentId, answer.IntentId, 'a repeated request answers the open intent')
            assert.equal(f.Intents.ForHive(C.HiveId).length, 1)
            const other = new RequestEnvironmentRequest(S.ClientId, C.HiveId, 'prod', RequestedEnvironmentPurpose.Development)
            assert.equal((await C.Code(f.Service().RequestEnvironment(S.Admin(), other))).code, CustomerErrorCode.InvalidRequest, 'another purpose for an open request')
        })

        it(`${backend}: request-environment past the open-intent cap is rate-limited`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f)
            await f.EnrolledHive(C.HiveId, C.TenantId, HiveLevel.Enrolled)
            for (let i = 0; i < IntentPublisher.MaxOpen; i++)
            {
                await f.Service().RequestEnvironment(S.Admin(), new RequestEnvironmentRequest(S.ClientId, C.HiveId, 'env-' + i, RequestedEnvironmentPurpose.Runtime))
            }
            const over = new RequestEnvironmentRequest(S.ClientId, C.HiveId, 'one-more', RequestedEnvironmentPurpose.Runtime)
            assert.equal((await C.Code(f.Service().RequestEnvironment(S.Admin(), over))).code, CustomerErrorCode.RateLimited)
        })

        it(`${backend}: request-environment refuses a hive that takes no intents, another client's hive, and a non-admin`, async () =>
        {
            const f = await CustomerFixture.Open(await makeSession())
            await C.Ready(f, C.TwoHives)
            await f.Hive(C.HiveId, C.TenantId)
            const request = new RequestEnvironmentRequest(S.ClientId, C.HiveId, 'prod', RequestedEnvironmentPurpose.Development)
            assert.equal((await C.Code(f.Service().RequestEnvironment(S.Admin(), request))).code, CustomerErrorCode.HiveTakesNoIntents)
            await f.State(S.Statement(1, { ClientId: C.OtherClient }))
            await f.Service().CreateTenant(S.Admin(), new CreateTenantRequest(C.OtherClient, C.OtherTenant, C.OtherTenant))
            await f.EnrolledHive(C.OtherHive, C.OtherTenant, HiveLevel.Enrolled)
            assert.equal((await C.Code(f.Service().RequestEnvironment(S.Admin(), new RequestEnvironmentRequest(S.ClientId, C.OtherHive, 'prod', RequestedEnvironmentPurpose.Runtime)))).code, CustomerErrorCode.UnknownHive)
            assert.equal((await C.Code(f.Service().RequestEnvironment(CentralLoginSubject.Of(S.Issuer, 'gip-stranger', 'stranger@other.test'), request))).code, CustomerErrorCode.NotAdminOfClient)
        })
    })
})
