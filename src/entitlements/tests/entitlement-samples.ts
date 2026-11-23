import { CentralLoginSubject, ClientKind, EntitlementLimits, EntitlementState, EntitlementStatement } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { ClientRegistry } from '../../client-registry.js'
import { PlatformAdminDatabase, PlatformAdminRegistry } from '../../platform-admin-database.js'

/** What a sample statement may differ in. */
export interface SampleStatementOptions
{
    ClientId?: string
    ClientName?: string
    ClientKind?: ClientKind
    State?: EntitlementState
    Limits?: Record<string, number>
    IssuedAt?: Date
    Admins?: readonly CentralLoginSubject[]
}

/** Statements for the entitlement and customer tests. */
export class EntitlementSamples
{
    public static readonly ClientId = 'acme'
    public static readonly ClientName = 'Acme Ltd'
    public static readonly Issuer = 'https://login.pragmatic-tech.ai/realms/central'
    public static readonly AdminSubject = 'gip-admin-1'
    public static readonly AdminEmail = 'admin@acme.test'
    public static readonly PlanId = 'starter'
    public static readonly IssuedAt = new Date('2026-11-20T10:00:00.000Z')
    public static readonly DefaultLimits: Readonly<Record<string, number>> = { 'tenants': 1, 'hives': 1, 'verified-domains': 1 }

    public static Admin(): CentralLoginSubject
    {
        return CentralLoginSubject.Of(EntitlementSamples.Issuer, EntitlementSamples.AdminSubject, EntitlementSamples.AdminEmail)
    }

    public static Statement(version: number, options: SampleStatementOptions = {}): EntitlementStatement
    {
        const S = EntitlementSamples
        return EntitlementStatement.Create({
            ClientId: options.ClientId ?? S.ClientId,
            ClientKind: options.ClientKind ?? ClientKind.Organisation,
            ClientName: options.ClientName ?? S.ClientName,
            Admins: options.Admins ?? [S.Admin()],
            PlanId: S.PlanId,
            Limits: EntitlementLimits.Of(options.Limits ?? S.DefaultLimits),
            State: options.State ?? EntitlementState.Active,
            Version: version,
            IssuedAt: options.IssuedAt ?? S.IssuedAt,
        })
    }

    /** The database and a loaded client registry over one session. */
    public static async Open(session: ISqlSession): Promise<{ Database: PlatformAdminDatabase; Clients: ClientRegistry }>
    {
        const database = PlatformAdminDatabase.Over(session)
        const clients = new ClientRegistry(await database.Map(PlatformAdminRegistry.Clients))
        await clients.Load()
        return { Database: database, Clients: clients }
    }
}
