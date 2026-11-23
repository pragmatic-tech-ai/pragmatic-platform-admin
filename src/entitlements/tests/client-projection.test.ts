import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { ClientKind } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { ClientProjection } from '../client-projection.js'
import { SqlEntitlementSink } from '../sql-entitlement-sink.js'
import { EntitlementSamples } from './entitlement-samples.js'

class ProjectionFixture
{
    public static readonly PersonName = 'Ada'
    public static readonly OrganisationName = 'Ada Ltd'
    public static readonly LaterIssue = new Date('2026-11-21T00:00:00.000Z')
    public static readonly OldName = 'Old name'
    public static readonly OperatorCreatedAt = '2026-10-01T00:00:00.000Z'
    public static readonly Six = 'Six'
    public static readonly Five = 'Five'
}

describe('ClientProjection', () =>
{
    const S = EntitlementSamples
    const F = ProjectionFixture
    SqlTestSessions.Describe('ClientProjection', (makeSession, backend) =>
    {
        it(`${backend}: projects ClientName and ClientKind onto the client record`, async () =>
        {
            const { Database, Clients } = await S.Open(await makeSession())
            const sink = await SqlEntitlementSink.Open(Database, new ClientProjection(Clients))
            await sink.Apply(S.Statement(1, { ClientKind: ClientKind.Person, ClientName: F.PersonName }))
            assert.deepEqual(Clients.Get(S.ClientId), { id: S.ClientId, displayName: F.PersonName, kind: ClientKind.Person, createdAt: S.IssuedAt.toISOString(), entitlementVersion: 1 })
            await sink.Apply(S.Statement(2, { ClientKind: ClientKind.Organisation, ClientName: F.OrganisationName, IssuedAt: F.LaterIssue }))
            assert.deepEqual(Clients.Get(S.ClientId), { id: S.ClientId, displayName: F.OrganisationName, kind: ClientKind.Organisation, createdAt: S.IssuedAt.toISOString(), entitlementVersion: 2 })
        })

        it(`${backend}: a client created by an operator before D4 keeps its id and createdAt when its first statement arrives`, async () =>
        {
            const { Database, Clients } = await S.Open(await makeSession())
            await Clients.Put({ id: S.ClientId, displayName: F.OldName, createdAt: F.OperatorCreatedAt })
            const sink = await SqlEntitlementSink.Open(Database, new ClientProjection(Clients))
            await sink.Apply(S.Statement(3))
            assert.deepEqual(Clients.Get(S.ClientId), { id: S.ClientId, displayName: S.ClientName, kind: ClientKind.Organisation, createdAt: F.OperatorCreatedAt, entitlementVersion: 3 })
            assert.equal(Clients.List().length, 1)
        })

        it(`${backend}: a projection older than the record changes nothing`, async () =>
        {
            const { Clients } = await S.Open(await makeSession())
            const projection = new ClientProjection(Clients)
            await projection.Project(S.Statement(6, { ClientName: F.Six }))
            await projection.Project(S.Statement(5, { ClientName: F.Five }))
            assert.equal(Clients.Get(S.ClientId)?.displayName, F.Six)
        })
    })
})
