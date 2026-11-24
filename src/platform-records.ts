import type { ClientKind } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { HiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import type { ConsoleAddressOption } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
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

/** Building a client record from its named fields only, so nothing else a stored row carries (the `subscriptionRef` a
 *  pre-D4 record held, any commercial field) is kept or shown. */
export class ClientRecords
{
    public static Of(raw: ClientRecord): ClientRecord
    {
        const record: ClientRecord = { id: raw.id, displayName: raw.displayName, createdAt: raw.createdAt }
        if (raw.kind !== undefined)
        {
            record.kind = raw.kind
        }
        if (raw.entitlementVersion !== undefined)
        {
            record.entitlementVersion = raw.entitlementVersion
        }
        return record
    }
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
    /** An enrolled hive's public key (the hive protocol's text form; the private half never left the cluster) and its
     *  key id. Absent on a hive the platform installed by push (it holds an agent token instead, `agentTokenRef`). */
    publicKey?: string
    keyId?: string
    /** The engine version the hive reported at enrolment. */
    engineVersion?: string
    /** Where the enrolled hive's console is reached, as reported at enrolment. */
    consoleAddress?: EnrolledConsoleAddress
    enrolledAt?: string
    /** The subject key of the customer admin whose one-time code enrolled the hive. */
    enrolledBy?: string
    /** The hosted placement the hive was placed by (C5.1), once its host placed it. */
    placementId?: string
}

/** An enrolled hive's console address (the hive protocol's ConsoleAddress, kept in the record's own casing). */
export type EnrolledConsoleAddress = {
    Option: ConsoleAddressOption
    Host: string
    IngressAddress: string | null
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

    /** Whether the hive enrolled itself by its key (C3.3), rather than being installed by push with an agent token. */
    public static IsEnrolled(hive: PlatformHiveRecord): boolean
    {
        return hive.publicKey !== undefined
    }

    /** Whether the hive serves its tenant's console: one the operator configured, or the engine console it enrolled from. */
    public static ServesConsole(hive: PlatformHiveRecord): boolean
    {
        return hive.console !== undefined || hive.consoleAddress !== undefined
    }
}
