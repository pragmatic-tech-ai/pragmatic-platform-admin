import { JsonRecordStore, type IRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { HiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'

/** What an enrolment code enrols: a hive (the engine's console connects it) or a host (a machine's agent). */
export enum EnrolmentAgentKind
{
    Hive = 'hive',
    Host = 'host',
}

/**
 * One issued enrolment code: never the code itself, only its SHA-256 (the record id). Bound to the client, the tenant,
 * the level and the agent kind it was issued for; single use (`redeemedAt` once used) and short-lived (`expiresAt`).
 */
export type EnrolmentCodeRecord = {
    /** The SHA-256 of the code, hex. */
    id: string
    clientId: string
    tenantId: string
    level: HiveLevel
    agentKind: EnrolmentAgentKind
    /** The subject key of the customer admin who asked for it. */
    issuedBy: string
    issuedAt: string
    expiresAt: string
    redeemedAt?: string
}

export class EnrolmentCodeRegistry extends JsonRecordStore<EnrolmentCodeRecord>
{
    public static readonly RootKey = 'enrolmentCodes'

    public constructor(location: string | IRecordMap<EnrolmentCodeRecord>)
    {
        super(location, EnrolmentCodeRegistry.RootKey)
    }
}
