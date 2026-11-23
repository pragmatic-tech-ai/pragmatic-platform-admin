import type { IRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/** How an operator signs in: the realm's OIDC sign-in (staff) or the console's own break-glass password. */
export enum OperatorSignInMethod
{
    Staff = 'staff',
    BreakGlass = 'break-glass',
}

/** The operator role the realm gave a staff operator at their last sign-in (None: their last sign-in carried none). */
export enum StaffOperatorRole
{
    Full = 'operator.full',
    ReadOnly = 'operator.read-only',
    None = '',
}

/** One operator signed in through the realm: who (principal, email), the operator role the realm last gave, when, and
 *  whether an operator disabled them here. Never a password or a token. */
export type StaffOperatorRecord =
{
    principal: string
    email: string
    method: OperatorSignInMethod
    role: StaffOperatorRole
    firstSignInAt: string
    lastSignInAt: string
    disabled: boolean
}

/** What the session gate asks on every request of a staff session: the role the operator holds now, or None when
 *  they are unknown here, disabled, or their last sign-in carried no operator role. */
export interface IStaffOperatorStanding
{
    RoleOf(principal: string): Promise<StaffOperatorRole>
}

/**
 * The operators who sign in through the realm (OIDC), recorded at their first sign-in and updated at every one, for the
 * operators view: principal (`oidc:<issuer>#<sub>`), email, method, the operator role the realm last gave, first and
 * last sign-in, and the disabled flag an operator with full rights sets here. Their roles come from the realm at each
 * sign-in; a sign-in without an operator role sets the record's role to None. The session gate asks RoleOf on every
 * request, so disabling an operator here, or the realm taking their role away (seen at their next sign-in attempt),
 * ends their sessions at once, whatever the sessions carry. Records live in the console's database
 * (`records_operator_directory`), loaded once: the console runs as one process, the only writer of this table (a second
 * replica would not see this one's writes). Every change is serialised and written through before it is visible.
 */
export class OperatorDirectory implements IStaffOperatorStanding
{
    private readonly records = new Map<string, StaffOperatorRecord>()
    private loading: Promise<void> | undefined
    private queue: Promise<unknown> = Promise.resolve()

    public constructor(private readonly map: IRecordMap<StaffOperatorRecord>)
    {
    }

    public async RoleOf(principal: string): Promise<StaffOperatorRole>
    {
        await this.Load()
        const record = this.records.get(principal)
        return record === undefined || record.disabled ? StaffOperatorRole.None : record.role
    }

    public async IsDisabled(principal: string): Promise<boolean>
    {
        await this.Load()
        return this.records.get(principal)?.disabled === true
    }

    /** Records a sign-in the realm completed with `role` (None: no operator role; an unrecorded person is then not
     *  recorded). Answers the record as stored, or undefined when nothing was recorded. */
    public RecordSignIn(principal: string, email: string, role: StaffOperatorRole, at: Date): Promise<StaffOperatorRecord | undefined>
    {
        return this.Serialised(async () => {
            const prior = this.records.get(principal)
            if (prior === undefined && role === StaffOperatorRole.None)
            {
                return undefined
            }
            const when = at.toISOString()
            const record: StaffOperatorRecord = {
                principal,
                email,
                method: OperatorSignInMethod.Staff,
                role,
                firstSignInAt: prior?.firstSignInAt ?? when,
                lastSignInAt: when,
                disabled: prior?.disabled ?? false,
            }
            await this.Write(record)
            return record
        })
    }

    /** Disables or enables a recorded operator; false when the principal was never recorded. */
    public SetDisabled(principal: string, disabled: boolean): Promise<boolean>
    {
        return this.Serialised(async () => {
            const prior = this.records.get(principal)
            if (prior === undefined)
            {
                return false
            }
            if (prior.disabled !== disabled)
            {
                await this.Write({ ...prior, disabled })
            }
            return true
        })
    }

    /** Every recorded operator, newest sign-in first. */
    public async List(): Promise<readonly StaffOperatorRecord[]>
    {
        await this.Load()
        return [...this.records.values()].sort((a, b) => b.lastSignInAt.localeCompare(a.lastSignInAt))
    }

    /** Runs `change` after every earlier change has finished (each reads the records as the last one left them). */
    private Serialised<T>(change: () => Promise<T>): Promise<T>
    {
        const run = this.queue.then(async () => {
            await this.Load()
            return await change()
        })
        this.queue = run.catch(() => undefined)
        return run
    }

    /** Durable first, then visible: a failed save leaves the records as they were. */
    private async Write(record: StaffOperatorRecord): Promise<void>
    {
        const next = new Map(this.records)
        next.set(record.principal, record)
        await this.map.Save(next, new Set([record.principal]))
        this.records.set(record.principal, record)
    }

    private Load(): Promise<void>
    {
        this.loading ??= this.map.Load().then(stored => {
            for (const [key, record] of stored)
            {
                this.records.set(key, record)
            }
        }, (err: unknown) => {
            // A failed load is retried by the next call, not remembered.
            this.loading = undefined
            throw err
        })
        return this.loading
    }
}
