import type { EntitlementStatement } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { ClientLock } from '../customer/client-lock.js'
import { ClientUsage } from '../customer/client-usage.js'
import type { IClientStatements } from '../entitlements/client-statements.js'
import { OperatorEntitlementGate } from '../entitlements/operator-entitlement-gate.js'
import { EntitlementSamples, type SampleStatementOptions } from '../entitlements/tests/entitlement-samples.js'
import type { PlatformDirectory } from '../platform-directory.js'

/**
 * Statements for the operator-side tests: every client is active with generous limits unless a test states another
 * statement for it (`State`), so the tests that are not about entitlements create tenants and hives as before.
 */
export class TestEntitlements implements IClientStatements
{
    public static readonly GenerousLimits: Readonly<Record<string, number>> = { 'tenants': 1000, 'hives': 1000, 'verified-domains': 1000 }
    private readonly stated = new Map<string, EntitlementStatement | undefined>()

    /** The operator gate over these statements and the directory's usage. */
    public static Gate(directory: PlatformDirectory, statements: TestEntitlements = new TestEntitlements()): OperatorEntitlementGate
    {
        return new OperatorEntitlementGate(statements, new ClientUsage(directory, { HeldCount: () => 0 }), new ClientLock())
    }

    /** Overrides one client's statement (undefined: the console holds none for it). */
    public State(clientId: string, options: SampleStatementOptions | undefined): void
    {
        this.stated.set(clientId, options === undefined ? undefined : EntitlementSamples.Statement(1, { ...options, ClientId: clientId }))
    }

    public async Current(clientId: string): Promise<EntitlementStatement | undefined>
    {
        if (this.stated.has(clientId))
        {
            return this.stated.get(clientId)
        }
        return EntitlementSamples.Statement(1, { ClientId: clientId, Limits: TestEntitlements.GenerousLimits })
    }
}
