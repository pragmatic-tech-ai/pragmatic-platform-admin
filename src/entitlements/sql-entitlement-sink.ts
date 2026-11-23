import { SqlRecordStore, SqlRecordVersionConflictError } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { EntitlementStatement } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { IEntitlementSink } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { PlatformAdminDatabase } from '../platform-admin-database.js'
import { PlatformAdminRegistry } from '../platform-admin-database.js'
import type { ClientProjection } from './client-projection.js'
import type { EntitlementRecord } from './entitlement-record.js'

/** Apply lost the conditional write on every attempt (another writer kept changing the client's row). */
export class EntitlementSinkContentionError extends Error
{
    private static readonly ErrorName = 'EntitlementSinkContentionError'
    private static readonly MessagePrefix = 'entitlement statement not stored after repeated conflicts: '

    public constructor(clientId: string)
    {
        super(EntitlementSinkContentionError.MessagePrefix + clientId)
        this.name = EntitlementSinkContentionError.ErrorName
    }
}

/**
 * The console's entitlement sink: the newest statement per client in `records_entitlements`, written only when it is
 * newer than the stored one, conditionally on the row version read (PutIfVersion), so two writers racing (an outbox
 * retry and a restart) end with the higher version whatever the order. Each stored statement is projected onto the
 * client record (ClientProjection); opening the sink re-projects every stored statement, so a crash between the write
 * and the projection cannot leave the record behind.
 */
export class SqlEntitlementSink implements IEntitlementSink
{
    private static readonly MaxAttempts = 8

    private constructor(private readonly store: SqlRecordStore<EntitlementRecord>, private readonly projection: ClientProjection, private readonly now: () => Date)
    {
    }

    public static async Open(database: PlatformAdminDatabase, projection: ClientProjection, now: () => Date = () => new Date()): Promise<SqlEntitlementSink>
    {
        const store = await SqlRecordStore.Open<EntitlementRecord>(database.Session, PlatformAdminRegistry.Entitlements)
        const sink = new SqlEntitlementSink(store, projection, now)
        await sink.ProjectAll()
        return sink
    }

    public async CurrentVersion(clientId: string): Promise<number | undefined>
    {
        return (await this.store.Get(clientId))?.version
    }

    /** The client's newest statement, or undefined when the console holds none. */
    public async Current(clientId: string): Promise<EntitlementStatement | undefined>
    {
        const record = await this.store.Get(clientId)
        return record === undefined ? undefined : EntitlementStatement.Parse(record.statement)
    }

    /** Every stored statement (the operator's clients view). */
    public async All(): Promise<readonly EntitlementStatement[]>
    {
        return (await this.store.List()).map(record => EntitlementStatement.Parse(record.statement))
    }

    public async Apply(statement: EntitlementStatement): Promise<void>
    {
        const record: EntitlementRecord = { id: statement.ClientId, statement: statement.ToJson(), version: statement.Version, receivedAt: this.now().toISOString() }
        for (let attempt = 0; attempt < SqlEntitlementSink.MaxAttempts; attempt++)
        {
            const current = await this.store.GetVersioned(statement.ClientId)
            if (current !== undefined && current.Record.version >= statement.Version)
            {
                return
            }
            try
            {
                await this.store.PutIfVersion(record, current?.Version ?? 0)
            }
            catch (err)
            {
                if (err instanceof SqlRecordVersionConflictError)
                {
                    continue
                }
                throw err
            }
            await this.projection.Project(statement)
            return
        }
        throw new EntitlementSinkContentionError(statement.ClientId)
    }

    private async ProjectAll(): Promise<void>
    {
        for (const statement of await this.All())
        {
            await this.projection.Project(statement)
        }
    }
}
