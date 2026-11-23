import { EntitledOperation } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { PlatformDirectory } from '../platform-directory.js'
import { PlatformHiveRecords, type PlatformHiveRecord } from '../platform-records.js'

/** Hives a client holds before they exist: unexpired unredeemed enrolment codes, open placements. */
export interface IHiveReservations
{
    OutstandingFor(clientId: string, now: Date): number
}

/** The email domains a set of tenants holds (claimed and not revoked: pending or verified). */
export interface IDomainUsage
{
    HeldCount(tenantIds: readonly string[]): number
}

/**
 * How much of each gated operation's limit a client uses now, counted at the moment of the decision (callers run it
 * inside the client's ClientLock section): `create-tenant` = its tenants; `enrol-hive` = its tenants' hives that are
 * not gone, plus every reservation (an unexpired unredeemed enrolment code, an open placement), so a client cannot
 * hold more pending hives than its plan; `verify-email-domain` = its tenants' domains pending or verified.
 */
export class ClientUsage
{
    public constructor(
        private readonly directory: PlatformDirectory,
        private readonly domains: IDomainUsage,
        private readonly reservations: readonly IHiveReservations[] = [],
        private readonly now: () => Date = () => new Date())
    {
    }

    public async Of(clientId: string, operation: EntitledOperation): Promise<number>
    {
        const tenantIds = this.directory.ListTenants(clientId).map(tenant => tenant.id)
        switch (operation)
        {
            case EntitledOperation.CreateTenant:
                return tenantIds.length
            case EntitledOperation.EnrolHive:
                return this.HivesOf(tenantIds) + this.ReservedFor(clientId)
            case EntitledOperation.VerifyEmailDomain:
                return this.domains.HeldCount(tenantIds)
        }
    }

    private HivesOf(tenantIds: readonly string[]): number
    {
        return tenantIds
            .flatMap(tenantId => this.directory.ListHives(tenantId) as readonly PlatformHiveRecord[])
            .filter(hive => !PlatformHiveRecords.HasLeft(hive))
            .length
    }

    private ReservedFor(clientId: string): number
    {
        const now = this.now()
        return this.reservations.reduce((sum, reservation) => sum + reservation.OutstandingFor(clientId, now), 0)
    }
}
