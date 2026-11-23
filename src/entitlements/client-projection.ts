import type { EntitlementStatement } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { ClientRegistry } from '../client-registry.js'
import type { ClientRecord } from '../platform-records.js'

/**
 * Derives the console's client record from a statement: name, kind and the statement version; the id and the creation
 * time of an existing record are kept (a client an operator created before D4 keeps both), and a record is never
 * deleted. A statement no newer than the one the record was derived from changes nothing, so projections that finish
 * out of order cannot move the record back.
 */
export class ClientProjection
{
    public constructor(private readonly clients: ClientRegistry)
    {
    }

    public async Project(statement: EntitlementStatement): Promise<void>
    {
        const existing = this.clients.Get(statement.ClientId)
        if (existing?.entitlementVersion !== undefined && existing.entitlementVersion >= statement.Version)
        {
            return
        }
        const record: ClientRecord = {
            id: statement.ClientId,
            displayName: statement.ClientName,
            kind: statement.ClientKind,
            createdAt: existing?.createdAt ?? statement.IssuedAt.toISOString(),
            entitlementVersion: statement.Version,
        }
        await this.clients.Put(record)
    }
}
