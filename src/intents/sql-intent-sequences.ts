import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { SqlMigration, SqlMigrationModule, SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters'

/** Schema of the per-hive intent sequence. */
export class SqlIntentSequenceMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE hive_intent_sequences (hive_id text PRIMARY KEY, allocated bigint NOT NULL, pulled bigint NOT NULL)',
    ])

    public readonly Name = 'hive.intent-sequences'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlIntentSequenceMigrations.V1]
    }
}

/** The intent sequence could not be allocated after the retries (another process kept winning). */
export class IntentSequenceContendedError extends Error
{
    public static readonly Code = 'intent-sequence-contended'
    private static readonly ErrorName = 'IntentSequenceContendedError'
    private static readonly Text = 'The hive intent sequence stayed contended; try again.'

    public constructor()
    {
        super(IntentSequenceContendedError.Text)
        this.name = IntentSequenceContendedError.ErrorName
    }
}

/** Where intent sequence numbers come from. */
export interface IIntentSequences
{
    /** The next number for the hive: above every number allocated, every cursor the hive pulled after, and `floor`. */
    Next(hiveId: string, floor: number): Promise<number>
    /** The hive pulled after `cursor`: no number at or below it is allocated from now on. */
    Saw(hiveId: string, cursor: number): Promise<void>
}

/**
 * Each hive's intent numbers in the console's Postgres (C3.4): one row per hive with the highest number allocated and
 * the highest cursor the hive ever pulled after. A number is the larger of the two (and of the outbox's own highest)
 * plus one, written by a version-conditional update (or the row's insert), retried on a lost race, so two processes
 * never allocate one number twice. Because the hive's cursor raises the floor, a restore from an older backup cannot
 * hand out numbers the hive has already pulled past (it would never be served them).
 */
export class SqlIntentSequences implements IIntentSequences
{
    private static readonly SelectSql = 'SELECT allocated, pulled FROM hive_intent_sequences WHERE hive_id = $1'
    private static readonly InsertSql = 'INSERT INTO hive_intent_sequences (hive_id, allocated, pulled) VALUES ($1, $2, $3)'
    private static readonly AllocateSql = 'UPDATE hive_intent_sequences SET allocated = $2 WHERE hive_id = $1 AND allocated = $3 AND pulled = $4'
    private static readonly SawSql = 'UPDATE hive_intent_sequences SET pulled = $2 WHERE hive_id = $1 AND pulled < $2'
    private static readonly UniqueViolation = '23505'
    private static readonly Attempts = 8

    private constructor(private readonly session: ISqlSession)
    {
    }

    public static async Open(session: ISqlSession): Promise<SqlIntentSequences>
    {
        await SqlMigrationRunner.Run(session, new SqlIntentSequenceMigrations())
        return new SqlIntentSequences(session)
    }

    public async Next(hiveId: string, floor: number): Promise<number>
    {
        const S = SqlIntentSequences
        for (let attempt = 0; attempt < S.Attempts; attempt++)
        {
            const row = await this.Row(hiveId)
            if (row === undefined)
            {
                const first = floor + 1
                if (await this.Insert(hiveId, first, 0))
                {
                    return first
                }
                continue
            }
            const next = Math.max(row.allocated, row.pulled, floor) + 1
            if (await this.session.Execute(S.AllocateSql, [hiveId, next, row.allocated, row.pulled]) === 1)
            {
                return next
            }
        }
        throw new IntentSequenceContendedError()
    }

    public async Saw(hiveId: string, cursor: number): Promise<void>
    {
        const S = SqlIntentSequences
        for (let attempt = 0; attempt < S.Attempts; attempt++)
        {
            const row = await this.Row(hiveId)
            if (row === undefined)
            {
                if (await this.Insert(hiveId, 0, cursor))
                {
                    return
                }
                continue
            }
            if (row.pulled >= cursor)
            {
                return
            }
            await this.session.Execute(S.SawSql, [hiveId, cursor])
        }
    }

    private async Row(hiveId: string): Promise<{ allocated: number, pulled: number } | undefined>
    {
        const row = (await this.session.Query(SqlIntentSequences.SelectSql, [hiveId]))[0]
        return row === undefined ? undefined : { allocated: Number(row.allocated), pulled: Number(row.pulled) }
    }

    /** False when another process inserted the hive's row first. */
    private async Insert(hiveId: string, allocated: number, pulled: number): Promise<boolean>
    {
        try
        {
            await this.session.Execute(SqlIntentSequences.InsertSql, [hiveId, allocated, pulled])
            return true
        }
        catch (error)
        {
            if ((error as { code?: string }).code === SqlIntentSequences.UniqueViolation)
            {
                return false
            }
            throw error
        }
    }
}
