import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { SqlRecordStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
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
    /** The key id of the agent that redeemed it, when it said. */
    redeemedByKeyId?: string
}

/** One code's row, read alone (never the whole table): what another process over the same database issued. */
export interface IEnrolmentCodeLookup
{
    Find(id: string): Promise<EnrolmentCodeRecord | undefined>
}

/** The single-row lookup over the console's `records_enrolment_codes` table (a SqlRecordMap row is `{ id, record }`). */
export class SqlEnrolmentCodeLookup implements IEnrolmentCodeLookup
{
    private constructor(private readonly store: SqlRecordStore<{ id: string; record: EnrolmentCodeRecord }>)
    {
    }

    public static async Open(session: ISqlSession, registry: string): Promise<SqlEnrolmentCodeLookup>
    {
        return new SqlEnrolmentCodeLookup(await SqlRecordStore.Open<{ id: string; record: EnrolmentCodeRecord }>(session, registry))
    }

    public async Find(id: string): Promise<EnrolmentCodeRecord | undefined>
    {
        return (await this.store.Get(id))?.record
    }
}

/**
 * The issued codes, in memory over their record map. A code issued by another process over the same database (the
 * admin image's `pragmatic-host-code` command) is not in this process's memory: Fetch reads that one row through the
 * lookup for a code it does not hold, and keeps what it found. Without a lookup a code not held is unknown.
 */
export class EnrolmentCodeRegistry extends JsonRecordStore<EnrolmentCodeRecord>
{
    public static readonly RootKey = 'enrolmentCodes'

    public constructor(location: string | IRecordMap<EnrolmentCodeRecord>, private readonly lookup?: IEnrolmentCodeLookup)
    {
        super(location, EnrolmentCodeRegistry.RootKey)
    }

    /** The record, from memory, else that one row from the database (kept in memory when found there). */
    public async Fetch(id: string): Promise<EnrolmentCodeRecord | undefined>
    {
        const held = this.Get(id)
        if (held !== undefined || this.lookup === undefined)
        {
            return held
        }
        const stored = await this.lookup.Find(id)
        if (stored !== undefined && this.Get(id) === undefined)
        {
            this.Stage(stored)
        }
        return this.Get(id)
    }
}
