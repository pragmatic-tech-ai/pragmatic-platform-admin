import type { ClientKind } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { HiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import type { HiveRecord, TenantRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/**
 * The console's operational client record, derived from the clients ledger's entitlement statements (ClientProjection):
 * no price, payment or provider reference. `kind` and `entitlementVersion` are absent only on a record an operator
 * created before D4, until its first statement arrives.
 */
export type ClientRecord = {
    id: string
    displayName: string
    kind?: ClientKind
    createdAt: string
    /** The version of the statement the record was last derived from. */
    entitlementVersion?: number
}

/** A tenant record as the console keeps it: the tenant plane's record plus who created it (a central-login subject's key
 *  for a customer admin, `operator:<email>` for an operator; absent on records created before D4). */
export type PlatformTenantRecord = TenantRecord & {
    createdBy?: string
}

/**
 * A hive record as the console keeps it: the tenant plane's record plus its management level and, once the customer
 * left it, when. A record without a level was created by the console before D4: every such hive is one the platform
 * placed on its own machines, so it reads as Hosted (PlatformHiveRecords.LevelOf). A left hive is kept (never deleted
 * by leaving) and no longer counts against the client's hives.
 */
export type PlatformHiveRecord = HiveRecord & {
    level?: HiveLevel
    leftAt?: string
}

/** Reading the console's additions to the hive record. */
export class PlatformHiveRecords
{
    /** The hive's level; a hive created before D4 is Hosted. */
    public static LevelOf(hive: PlatformHiveRecord): HiveLevel
    {
        return hive.level ?? HiveLevel.Hosted
    }

    public static HasLeft(hive: PlatformHiveRecord): boolean
    {
        return hive.leftAt !== undefined
    }
}
