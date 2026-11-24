import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { SqlMigration, SqlMigrationModule, SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { SystemProtocolClock, type INonceLedger, type IProtocolClock, type Participant } from '@pragmatic-tech-ai/pragmatic-hive-protocol'

/** Schema of the agent channel's nonce ledger. */
export class SqlNonceMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE hive_nonces (issuer text NOT NULL, nonce text NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY (issuer, nonce))',
        'CREATE INDEX hive_nonces_expires ON hive_nonces (expires_at)',
    ])

    public readonly Name = 'hive.nonces'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlNonceMigrations.V1]
    }
}

/**
 * The platform's INonceLedger in its Postgres (C3.3): one row per (issuer, nonce) until the message could no longer be
 * fresh. A claim is one atomic `INSERT` on the (issuer, nonce) primary key: of any number of concurrent claims of one
 * nonce, from any process over the same database, exactly one inserts and every other meets the unique violation (not
 * `ON CONFLICT DO NOTHING`, whose row count pg-mem misreports). Rows past their keep-until time are swept at most once a
 * minute, before a claim (the table stays the size of the last few minutes; a flood costs one INSERT per message).
 */
export class SqlNonceLedger implements INonceLedger
{
    private static readonly SweepSql = 'DELETE FROM hive_nonces WHERE expires_at < $1'
    private static readonly ClaimSql = 'INSERT INTO hive_nonces (issuer, nonce, expires_at) VALUES ($1, $2, $3)'
    private static readonly UniqueViolation = '23505'
    /** Expired rows are swept at most this often per ledger (an expired nonce left meanwhile blocks only a replay of a
     *  message that no longer verifies anyway: freshness is checked before the claim). */
    public static readonly SweepIntervalMs = 60_000
    private static readonly CountSql = 'SELECT count(*) AS n FROM hive_nonces'

    private lastSweep = Number.NEGATIVE_INFINITY

    private constructor(private readonly session: ISqlSession, private readonly clock: IProtocolClock)
    {
    }

    public static async Open(session: ISqlSession, clock: IProtocolClock = new SystemProtocolClock()): Promise<SqlNonceLedger>
    {
        await SqlMigrationRunner.Run(session, new SqlNonceMigrations())
        return new SqlNonceLedger(session, clock)
    }

    public async Claim(issuer: Participant, nonce: string, keepUntil: Date): Promise<boolean>
    {
        const now = this.clock.Now()
        if (now.getTime() - this.lastSweep >= SqlNonceLedger.SweepIntervalMs)
        {
            this.lastSweep = now.getTime()
            await this.session.Execute(SqlNonceLedger.SweepSql, [now.toISOString()])
        }
        try
        {
            await this.session.Execute(SqlNonceLedger.ClaimSql, [issuer.Key, nonce, keepUntil.toISOString()])
            return true
        }
        catch (error)
        {
            if ((error as { code?: string }).code === SqlNonceLedger.UniqueViolation)
            {
                return false
            }
            throw error
        }
    }

    /** How many nonces are kept (tests, the operator's view of the channel). */
    public async Size(): Promise<number>
    {
        const row = (await this.session.Query(SqlNonceLedger.CountSql, []))[0]
        return Number(row?.n ?? 0)
    }
}
