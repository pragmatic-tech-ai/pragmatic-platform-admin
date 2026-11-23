/** One stored entitlement statement: the newest the console accepted for the client. */
export type EntitlementRecord = {
    /** The client id. */
    id: string
    /** The statement's wire form (EntitlementStatement.ToJson). */
    statement: unknown
    /** The statement's own version (not the row version). */
    version: number
    receivedAt: string
}
