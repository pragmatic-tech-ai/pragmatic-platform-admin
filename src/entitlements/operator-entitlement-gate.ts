import { EntitlementDecision } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { EntitledOperation, EntitlementStatement } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CustomerApiError, CustomerErrorCode, CustomerErrorCodes } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { ClientLock } from '../customer/client-lock.js'
import type { ClientUsage } from '../customer/client-usage.js'
import type { IClientStatements } from './client-statements.js'

/** What the operator's clients view shows of a client's statement: never a price. */
export type ClientEntitlementSummary = {
    planId: string
    state: string
    limits: Record<string, number>
    version: number
    issuedAt: string
    admins: Array<{ issuer: string; subject: string; email: string }>
}

/**
 * The operator side's entitlement check: an operator creating a tenant or a hive for a client passes the same decision
 * as the client's own admins (the client's newest statement at its current usage, in the client's ClientLock section,
 * shared with the customer API). A client the console holds no statement for allows nothing (deny by default,
 * `not-in-plan`). A refusal is the 403 `not-entitled` problem with its reason. Without statements or usage (a console
 * composed without them) every gated operation is refused.
 */
export class OperatorEntitlementGate
{
    public constructor(
        private readonly statements: IClientStatements | undefined,
        private readonly usage: ClientUsage | undefined,
        private readonly lock: ClientLock = new ClientLock())
    {
    }

    /** A gate that refuses every gated operation (a console without the ledger's statements). */
    public static DenyAll(): OperatorEntitlementGate
    {
        return new OperatorEntitlementGate(undefined, undefined)
    }

    /** Runs `work` once every operation is allowed for the client, all decided and done in one section of its lock. */
    public Run<T>(clientId: string, operations: readonly EntitledOperation[], work: () => Promise<T>): Promise<T>
    {
        return this.lock.Run(clientId, async () =>
        {
            const statement = await this.statements?.Current(clientId)
            for (const operation of operations)
            {
                const decision = statement === undefined || this.usage === undefined
                    ? EntitlementDecision.NotInPlan
                    : statement.Entitlement.Decide(operation, await this.usage.Of(clientId, operation))
                if (decision !== EntitlementDecision.Allowed)
                {
                    throw new CustomerApiError(CustomerErrorCode.NotEntitled, CustomerErrorCodes.ReasonOf(decision))
                }
            }
            return await work()
        })
    }

    /** The client's statement summary for the operator, or undefined when the console holds none. */
    public async Summary(clientId: string): Promise<ClientEntitlementSummary | undefined>
    {
        const statement = await this.statements?.Current(clientId)
        return statement === undefined ? undefined : OperatorEntitlementGate.SummaryOf(statement)
    }

    private static SummaryOf(statement: EntitlementStatement): ClientEntitlementSummary
    {
        return {
            planId: statement.PlanId,
            state: statement.State,
            limits: statement.Limits.ToJson(),
            version: statement.Version,
            issuedAt: statement.IssuedAt.toISOString(),
            admins: statement.Admins.map(admin => ({ issuer: admin.Issuer, subject: admin.Subject, email: admin.Email })),
        }
    }
}
