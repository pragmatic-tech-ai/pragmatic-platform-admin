import type { ClientKind } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'

/**
 * The console's operational client record, derived from the clients ledger's entitlement statements (ClientProjection):
 * no price, payment or provider reference. `kind` and `entitlementVersion` are absent only on a record an operator
 * created before D4, until its first statement arrives.
 */
export type ClientRecord = {
    id: string
    displayName: string
    kind?: ClientKind
    createdAt: string
    /** The version of the statement the record was last derived from. */
    entitlementVersion?: number
}
