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
 * A host code (agent kind host, C5.1) is the platform's own: it names no client and no tenant (both empty, level
 * hosted), so it never reserves a customer's hive. A hosted hive's code names the placement it was issued for: the
 * placement already reserves the client's hive, so the code does not count again.
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
    /** The hosted placement the code was issued for (the scheduler's codes only). */
    placementId?: string
}

/**
 * The issued codes, in memory over their record map. A code issued by another process over the same database (the
 * admin image's `pragmatic-host-code` command) is not in this process's memory: Fetch reads the map once for a code
 * it does not hold and keeps what it found.
 */
export class EnrolmentCodeRegistry extends JsonRecordStore<EnrolmentCodeRecord>
{
    public static readonly RootKey = 'enrolmentCodes'
    private readonly source: IRecordMap<EnrolmentCodeRecord> | undefined

    public constructor(location: string | IRecordMap<EnrolmentCodeRecord>)
    {
        super(location, EnrolmentCodeRegistry.RootKey)
        this.source = typeof location === 'string' ? undefined : location
    }

    /** The record, from memory, else from the record map (kept in memory when found there). */
    public async Fetch(id: string): Promise<EnrolmentCodeRecord | undefined>
    {
        const held = this.Get(id)
        if (held !== undefined || this.source === undefined)
        {
            return held
        }
        const stored = (await this.source.Load()).get(id)
        if (stored !== undefined && this.Get(id) === undefined)
        {
            this.Stage(stored)
        }
        return this.Get(id)
    }
}
