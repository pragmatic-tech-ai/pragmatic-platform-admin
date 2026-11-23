import type { EntitlementStatement } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'

/** Where the console reads a client's newest entitlement statement (SqlEntitlementSink in production). */
export interface IClientStatements
{
    /** The client's newest statement, or undefined when the console holds none. */
    Current(clientId: string): Promise<EntitlementStatement | undefined>
}
