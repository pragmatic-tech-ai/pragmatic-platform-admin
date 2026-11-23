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
import { PlatformCustomerApiService, type CustomerApiServiceParts } from '../platform-customer-api-service.js'

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

    private constructor(
        public readonly Sink: SqlEntitlementSink,
        public readonly Directory: PlatformDirectory,
        public readonly Domains: PlatformEmailDomains,
        public readonly Adverts: ConsoleAdvertRegistry,
        public readonly Txt: FakeTxtResolver,
        public readonly Usage: ClientUsage,
        public readonly Lock: ClientLock,
        public readonly Parts: CustomerApiServiceParts)
    {
    }

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
        const usage = new ClientUsage(directory, domains, reservations)
        const lock = new ClientLock()
        const parts: CustomerApiServiceParts = { Statements: sink, Directory: directory, Domains: domains, Usage: usage, Lock: lock }
        return new CustomerFixture(sink, directory, domains, adverts, txt, usage, lock, parts)
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
}
