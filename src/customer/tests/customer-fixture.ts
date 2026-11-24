import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { CentralLoginSubject } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { EntitlementStatement } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { HiveBackend, InfraMode } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ConsoleAdvertRegistry } from '../../console-advert-registry.js'
import { ConsoleDomainApprovals } from '../../console-domain-approvals.js'
import { ClientProjection } from '../../entitlements/client-projection.js'
import { SqlEntitlementSink } from '../../entitlements/sql-entitlement-sink.js'
import { EntitlementSamples } from '../../entitlements/tests/entitlement-samples.js'
import { HiveRegistry } from '../../hive-registry.js'
import { PlatformAdminRegistry } from '../../platform-admin-database.js'
import { PlatformDirectory } from '../../platform-directory.js'
import { PlatformEmailDomains } from '../../platform-email-domains.js'
import { TenantRegistry } from '../../tenant-registry.js'
import { DomainTxtVerifier, TxtLookupStatus, type ITxtResolver, type TxtLookup } from '../../txt-resolver.js'
import { ClientLock } from '../client-lock.js'
import { ClientUsage, type IHiveReservations } from '../client-usage.js'
import { PlatformCustomerApiService, type CustomerApiServiceParts, type IHiveRegistrations, type IInstallReleases, type IOperatorActivity } from '../platform-customer-api-service.js'
import { EnrolmentCodeIssuer } from '../../enrolment/enrolment-code-issuer.js'
import { EnrolmentCodeRegistry } from '../../enrolment/enrolment-code-record.js'
import { PlacementRegistry } from '../../placement/placement-registry.js'
import { PlacementStore } from '../../placement/placement-record.js'
import { HiveObservationRegistry } from '../../hive-observation-record.js'
import { EnvelopeSigner, Participant, SigningKeyPair, SystemProtocolClock, ConsoleAddressOption } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { HiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { IntentOutbox } from '../../intents/intent-outbox.js'
import { IntentPublisher } from '../../intents/intent-publisher.js'
import { IntentStore } from '../../intents/intent-record.js'
import { SqlIntentSequences } from '../../intents/sql-intent-sequences.js'

/** The release the install command names (or none), and the hives whose registration was revoked. */
export class FakeDeployments implements IInstallReleases, IHiveRegistrations
{
    public static readonly Release = '0.1.0-early.7'
    public Release: string | undefined = FakeDeployments.Release
    public readonly Deregistered: string[] = []

    public InstallReleaseFor(_tenantId: string): string | undefined
    {
        return this.Release
    }

    public async DeregisterHive(hiveId: string): Promise<void>
    {
        this.Deregistered.push(hiveId)
    }
}

/** The operator activity entries the service records. */
export class FakeActivity implements IOperatorActivity
{
    public readonly Entries: Array<{ actor: string, action: string, target: string, status: number, note: string | undefined }> = []

    public async Record(actor: string, action: string, target: string, status: number, note?: string): Promise<void>
    {
        this.Entries.push({ actor, action, target, status, note })
    }
}

/** A clock the tests move. */
export class TestClock
{
    public Current = new Date('2026-11-23T12:00:00.000Z')

    public Now(): Date
    {
        return new Date(this.Current.getTime())
    }

    public Advance(ms: number): void
    {
        this.Current = new Date(this.Current.getTime() + ms)
    }
}

/** Answers every TXT lookup with `Answer`. */
export class FakeTxtResolver implements ITxtResolver
{
    public Answer: TxtLookup = { status: TxtLookupStatus.NoRecord, records: [] }

    public async ResolveTxt(_name: string): Promise<TxtLookup>
    {
        return { status: this.Answer.status, records: this.Answer.records.map(record => [...record]) }
    }
}

/** The customer API service over one SQL session (pg-mem or live), with its parts reachable for the tests. */
export class CustomerFixture
{
    public static readonly Stranger = CentralLoginSubject.Of(EntitlementSamples.Issuer, 'gip-stranger', 'stranger@elsewhere.test')
    public static readonly HiveDisplayName = 'Hive'
    private static readonly EngineVersion = '0.1.0-early.19'
    private static readonly ConsoleHost = 'console.acme.test'
    private static readonly EnrolledBy = 'central:sub-1'

    private constructor(
        public readonly Sink: SqlEntitlementSink,
        public readonly Directory: PlatformDirectory,
        public readonly Domains: PlatformEmailDomains,
        public readonly Adverts: ConsoleAdvertRegistry,
        public readonly Txt: FakeTxtResolver,
        public readonly Usage: ClientUsage,
        public readonly Lock: ClientLock,
        public readonly Codes: EnrolmentCodeIssuer,
        public readonly Placements: PlacementRegistry,
        public readonly Observations: HiveObservationRegistry,
        public readonly Deployments: FakeDeployments,
        public readonly Clock: TestClock,
        public readonly Activity: FakeActivity,
        public readonly Intents: IntentOutbox,
        public readonly Parts: CustomerApiServiceParts)
    {
    }

    /** `reservations`: extra ones besides the fixture's own codes and placements. */
    public static async Open(session: ISqlSession, reservations: readonly IHiveReservations[] = []): Promise<CustomerFixture>
    {
        const { Database, Clients } = await EntitlementSamples.Open(session)
        const sink = await SqlEntitlementSink.Open(Database, new ClientProjection(Clients))
        const directory = new PlatformDirectory(Clients, new TenantRegistry(await Database.Map(PlatformAdminRegistry.Tenants)), new HiveRegistry(await Database.Map(PlatformAdminRegistry.Hives)), { List: () => [] })
        await directory.Load()
        const adverts = new ConsoleAdvertRegistry(await Database.Map(PlatformAdminRegistry.ConsoleAdverts))
        const approvals = new ConsoleDomainApprovals(await Database.Map(PlatformAdminRegistry.ConsoleDomainApprovals))
        await adverts.Load()
        await approvals.Load()
        const txt = new FakeTxtResolver()
        const domains = new PlatformEmailDomains(directory, adverts, approvals, new DomainTxtVerifier(txt))
        const clock = new TestClock()
        const now = (): Date => clock.Now()
        const codeRegistry = new EnrolmentCodeRegistry(await Database.Map(PlatformAdminRegistry.EnrolmentCodes))
        const placementStore = new PlacementStore(await Database.Map(PlatformAdminRegistry.Placements))
        const observations = new HiveObservationRegistry(await Database.Map(PlatformAdminRegistry.HiveObservations))
        const intentStore = new IntentStore(await Database.Map(PlatformAdminRegistry.HiveIntents))
        await Promise.all([codeRegistry.Load(), placementStore.Load(), observations.Load(), intentStore.Load()])
        const intents = new IntentOutbox(intentStore, now)
        const publisher = new IntentPublisher(intents, directory, new EnvelopeSigner(SigningKeyPair.Generate(), Participant.Platform, new SystemProtocolClock()), await SqlIntentSequences.Open(session))
        const codes = new EnrolmentCodeIssuer(codeRegistry, now)
        const placements = new PlacementRegistry(placementStore, now)
        const usage = new ClientUsage(directory, domains, [codes, placements, ...reservations], now)
        const lock = new ClientLock()
        const deployments = new FakeDeployments()
        const activity = new FakeActivity()
        const parts: CustomerApiServiceParts = {
            Statements: sink, Directory: directory, Domains: domains, Usage: usage, Lock: lock, Codes: codes, Placements: placements,
            Releases: deployments, Registrations: deployments, Reports: observations, Adverts: adverts, Intents: publisher, Activity: activity, Now: now,
        }
        return new CustomerFixture(sink, directory, domains, adverts, txt, usage, lock, codes, placements, observations, deployments, clock, activity, intents, parts)
    }

    public Service(): PlatformCustomerApiService
    {
        return new PlatformCustomerApiService(this.Parts)
    }

    public async State(statement: EntitlementStatement): Promise<void>
    {
        await this.Sink.Apply(statement)
    }

    /** A hive record of `tenantId`, as an operator would register it. */
    public async Hive(id: string, tenantId: string): Promise<void>
    {
        await this.Directory.CreateHive({ id, tenantId, displayName: CustomerFixture.HiveDisplayName, cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach } })
    }

    /** A hive that enrolled itself by its key at `level` (C3.3), so it takes intents when Enrolled or Delegated. */
    public async EnrolledHive(id: string, tenantId: string, level: HiveLevel): Promise<void>
    {
        const key = SigningKeyPair.Generate().PublicKey
        await this.Directory.EnrolHive({
            id, tenantId, level, publicKey: key.ToJson(), keyId: key.KeyId, engineVersion: CustomerFixture.EngineVersion,
            consoleAddress: { Option: ConsoleAddressOption.OwnDomain, Host: CustomerFixture.ConsoleHost, IngressAddress: null }, enrolledBy: CustomerFixture.EnrolledBy,
        })
    }
}
