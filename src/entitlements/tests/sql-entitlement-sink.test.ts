import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { EntitlementState } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { EntitlementStatement } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { SqlEntitlementSink } from '../sql-entitlement-sink.js'
import { ClientProjection } from '../client-projection.js'
import { EntitlementSamples } from './entitlement-samples.js'

class SinkFixture
{
    public static readonly Five = 'Five'
    public static readonly Again = 'Again'
    public static readonly Three = 'Three'
    public static readonly OtherClient = 'globex'
    public static readonly Orders: ReadonlyArray<readonly [number, number]> = [[7, 8], [8, 7]]
    public static readonly NamePrefix = 'v'
}

/** A projection whose first Project throws (a crash between the SQL write and the projection). */
class FailingOnceProjection extends ClientProjection
{
    public static readonly Failure = /projection down/
    private static readonly FailureText = 'projection down'
    private failed = false

    public override async Project(statement: EntitlementStatement): Promise<void>
    {
        if (!this.failed)
        {
            this.failed = true
            throw new Error(FailingOnceProjection.FailureText)
        }
        await super.Project(statement)
    }
}

describe('SqlEntitlementSink', () =>
{
    const S = EntitlementSamples
    const F = SinkFixture
    SqlTestSessions.Describe('SqlEntitlementSink', (makeSession, backend) =>
    {
        it(`${backend}: applies version 1 then 2`, async () =>
        {
            const { Database, Clients } = await S.Open(await makeSession())
            const sink = await SqlEntitlementSink.Open(Database, new ClientProjection(Clients))
            assert.equal(await sink.CurrentVersion(S.ClientId), undefined)
            assert.equal(await sink.Current(S.ClientId), undefined)
            await sink.Apply(S.Statement(1))
            assert.equal(await sink.CurrentVersion(S.ClientId), 1)
            await sink.Apply(S.Statement(2, { State: EntitlementState.Suspended }))
            assert.equal(await sink.CurrentVersion(S.ClientId), 2)
            assert.equal((await sink.Current(S.ClientId))?.State, EntitlementState.Suspended)
        })

        it(`${backend}: Apply of a lower or equal version changes nothing`, async () =>
        {
            const { Database, Clients } = await S.Open(await makeSession())
            const sink = await SqlEntitlementSink.Open(Database, new ClientProjection(Clients))
            await sink.Apply(S.Statement(5, { ClientName: F.Five }))
            await sink.Apply(S.Statement(5, { ClientName: F.Again }))
            await sink.Apply(S.Statement(3, { ClientName: F.Three }))
            assert.equal(await sink.CurrentVersion(S.ClientId), 5)
            assert.equal((await sink.Current(S.ClientId))?.ClientName, F.Five)
            assert.equal(Clients.Get(S.ClientId)?.displayName, F.Five)
        })

        it(`${backend}: racing Apply of 7 and 8 leaves 8, whatever the order`, async () =>
        {
            for (const [first, second] of F.Orders)
            {
                const { Database, Clients } = await S.Open(await makeSession())
                // Two concurrent Apply calls race on one row with no receiver in front (which would serialise them per
                // client): only the SQL version condition orders them, even within one process.
                const sink = await SqlEntitlementSink.Open(Database, new ClientProjection(Clients))
                await Promise.all([sink.Apply(S.Statement(first, { ClientName: F.NamePrefix + first })), sink.Apply(S.Statement(second, { ClientName: F.NamePrefix + second }))])
                assert.equal(await sink.CurrentVersion(S.ClientId), 8)
                assert.equal((await sink.Current(S.ClientId))?.ClientName, F.NamePrefix + 8)
                assert.equal(Clients.Get(S.ClientId)?.displayName, F.NamePrefix + 8)
            }
        })

        it(`${backend}: a projection that failed after its statement was stored heals on the ledger's retry`, async () =>
        {
            const { Database, Clients } = await S.Open(await makeSession())
            const projection = new FailingOnceProjection(Clients)
            const sink = await SqlEntitlementSink.Open(Database, projection)
            await assert.rejects(sink.Apply(S.Statement(3, { ClientName: F.Three })), FailingOnceProjection.Failure)
            assert.equal(Clients.Get(S.ClientId), undefined)
            assert.equal(await sink.CurrentVersion(S.ClientId), undefined, 'the retry is not answered as a duplicate')
            await sink.Apply(S.Statement(3, { ClientName: F.Three }))
            assert.equal(Clients.Get(S.ClientId)?.displayName, F.Three)
            assert.equal(await sink.CurrentVersion(S.ClientId), 3)
        })

        it(`${backend}: opening the sink re-projects the stored statements`, async () =>
        {
            const session = await makeSession()
            const first = await S.Open(session)
            await (await SqlEntitlementSink.Open(first.Database, new ClientProjection(first.Clients))).Apply(S.Statement(4))
            await first.Clients.Remove(S.ClientId)
            const second = await S.Open(session)
            assert.equal(second.Clients.Get(S.ClientId), undefined)
            await SqlEntitlementSink.Open(second.Database, new ClientProjection(second.Clients))
            assert.equal(second.Clients.Get(S.ClientId)?.entitlementVersion, 4)
        })

        it(`${backend}: All lists every client's statement`, async () =>
        {
            const { Database, Clients } = await S.Open(await makeSession())
            const sink = await SqlEntitlementSink.Open(Database, new ClientProjection(Clients))
            await sink.Apply(S.Statement(1))
            await sink.Apply(S.Statement(1, { ClientId: F.OtherClient }))
            assert.deepEqual((await sink.All()).map(statement => statement.ClientId).sort(), [S.ClientId, F.OtherClient])
        })
    })
})
