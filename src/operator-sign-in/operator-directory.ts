import type { IRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/** How an operator signs in: the realm's OIDC sign-in (staff) or the console's own break-glass password. */
export enum OperatorSignInMethod
{
    Staff = 'staff',
    BreakGlass = 'break-glass',
}

/** One operator signed in through the realm: who (principal, email), the operator role the realm last gave, when, and
 *  whether an operator disabled them here. Never a password or a token. */
export type StaffOperatorRecord =
{
    principal: string
    email: string
    method: OperatorSignInMethod
    role: string
    firstSignInAt: string
    lastSignInAt: string
    disabled: boolean
}

/** The standing the session gate asks about on every request of a staff session. */
export interface IStaffOperatorStanding
{
    IsDisabled(principal: string): Promise<boolean>
}

/**
 * The operators who sign in through the realm (OIDC), recorded at their first sign-in and updated at every one, for the
 * operators view: principal (`oidc:<issuer>#<sub>`), email, method, the operator role the realm gave, first and last
 * sign-in, and the disabled flag an operator with full rights sets here. Their roles come from the realm on every
 * sign-in; disabling one here refuses their next sign-in and ends their sessions at once (the gate asks IsDisabled),
 * whatever the realm says. Records live in the console's database (`records_operator_directory`). Loaded once; every
 * change is written through.
 */
export class OperatorDirectory implements IStaffOperatorStanding
{
    private records = new Map<string, StaffOperatorRecord>()
    private loaded = false

    public constructor(private readonly map: IRecordMap<StaffOperatorRecord>)
    {
    }

    public async IsDisabled(principal: string): Promise<boolean>
    {
        await this.Load()
        return this.records.get(principal)?.disabled === true
    }

    /** Records a completed sign-in (the first one creates the record); answers the record as stored. */
    public async RecordSignIn(principal: string, email: string, role: string, at: Date): Promise<StaffOperatorRecord>
    {
        await this.Load()
        const prior = this.records.get(principal)
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
    }

    /** Disables or enables a recorded operator; false when the principal was never recorded. */
    public async SetDisabled(principal: string, disabled: boolean): Promise<boolean>
    {
        await this.Load()
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
    }

    /** Every recorded operator, newest sign-in first. */
    public async List(): Promise<readonly StaffOperatorRecord[]>
    {
        await this.Load()
        return [...this.records.values()].sort((a, b) => b.lastSignInAt.localeCompare(a.lastSignInAt))
    }

    private async Write(record: StaffOperatorRecord): Promise<void>
    {
        const next = new Map(this.records)
        next.set(record.principal, record)
        await this.map.Save(next, new Set([record.principal]))
        this.records = next
    }

    private async Load(): Promise<void>
    {
        if (this.loaded)
        {
            return
        }
        this.records = new Map(await this.map.Load())
        this.loaded = true
    }
}
