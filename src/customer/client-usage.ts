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
 * Usage an operator's allowed operation holds while its slow work (an IdP set-up, a provisioning) runs outside the
 * client's lock: decided and taken inside the section, so a concurrent decision sees it, and released once the work
 * ended (by then a successful work's own record counts instead).
 */
export class UsageReservation
{
    private released = false

    public constructor(private readonly usage: ClientUsage, public readonly ClientId: string, public readonly Operations: readonly EntitledOperation[])
    {
    }

    public Release(): void
    {
        if (!this.released)
        {
            this.released = true
            this.usage.Release(this)
        }
    }
}

/**
 * How much of each gated operation's limit a client uses now, counted at the moment of the decision (callers run it
 * inside the client's ClientLock section): `create-tenant` = its tenants; `enrol-hive` = its tenants' hives that are
 * not gone, plus every reservation (an unexpired unredeemed enrolment code, an open placement), so a client cannot
 * hold more pending hives than its plan; `verify-email-domain` = its tenants' domains pending or verified. Every count
 * adds the operations reserved for the client and not yet released (Reserve).
 */
export class ClientUsage
{
    private static readonly KeySeparator = '\n'

    private readonly reserved = new Map<string, number>()

    public constructor(
        private readonly directory: PlatformDirectory,
        private readonly domains: IDomainUsage,
        private readonly reservations: readonly IHiveReservations[] = [],
        private readonly now: () => Date = () => new Date())
    {
    }

    public async Of(clientId: string, operation: EntitledOperation): Promise<number>
    {
        return this.Recorded(clientId, operation) + (this.reserved.get(ClientUsage.KeyOf(clientId, operation)) ?? 0)
    }

    /** Holds one of each operation for the client until the reservation is released; take it inside the client's lock. */
    public Reserve(clientId: string, operations: readonly EntitledOperation[]): UsageReservation
    {
        for (const operation of operations)
        {
            const key = ClientUsage.KeyOf(clientId, operation)
            this.reserved.set(key, (this.reserved.get(key) ?? 0) + 1)
        }
        return new UsageReservation(this, clientId, operations)
    }

    /** Called by UsageReservation.Release. */
    public Release(reservation: UsageReservation): void
    {
        for (const operation of reservation.Operations)
        {
            const key = ClientUsage.KeyOf(reservation.ClientId, operation)
            const left = (this.reserved.get(key) ?? 0) - 1
            if (left > 0)
            {
                this.reserved.set(key, left)
            }
            else
            {
                this.reserved.delete(key)
            }
        }
    }

    private Recorded(clientId: string, operation: EntitledOperation): number
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

    private static KeyOf(clientId: string, operation: EntitledOperation): string
    {
        return clientId + ClientUsage.KeySeparator + operation
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
