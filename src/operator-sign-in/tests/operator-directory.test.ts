import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { MemoryRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { PlatformAdminDatabase, PlatformAdminRegistry } from '../../platform-admin-database.js'
import { OperatorDirectory, OperatorSignInMethod, StaffOperatorRole, type StaffOperatorRecord } from '../operator-directory.js'

/** A memory record map whose saves yield first, so overlapping writes interleave as they would over Postgres. */
class SlowRecordMap extends MemoryRecordMap<StaffOperatorRecord>
{
    private static readonly DelayMs = 5

    public override async Save(all: ReadonlyMap<string, StaffOperatorRecord>, changed: ReadonlySet<string>): Promise<void>
    {
        await new Promise(resolve => setTimeout(resolve, SlowRecordMap.DelayMs))
        await super.Save(all, changed)
    }
}

class DirectoryFixture
{
    public static readonly Principal = 'oidc:https://realm.test/realms/r#account-1'
    public static readonly Other = 'oidc:https://realm.test/realms/r#account-2'
    public static readonly Email = 'staff@pragmatic.test'
    public static readonly First = new Date('2026-11-23T10:00:00.000Z')
    public static readonly Later = new Date('2026-11-23T11:00:00.000Z')
}

describe('OperatorDirectory', () =>
{
    const F = DirectoryFixture

    it('records the first sign-in and updates the last one, keeping first sign-in and the disabled flag', async () =>
    {
        const directory = new OperatorDirectory(new MemoryRecordMap<StaffOperatorRecord>())
        await directory.RecordSignIn(F.Principal, F.Email, StaffOperatorRole.ReadOnly, F.First)
        assert.equal(await directory.SetDisabled(F.Principal, true), true)
        const record = await directory.RecordSignIn(F.Principal, F.Email, StaffOperatorRole.Full, F.Later)
        assert.deepEqual(record, { principal: F.Principal, email: F.Email, method: OperatorSignInMethod.Staff, role: StaffOperatorRole.Full, firstSignInAt: F.First.toISOString(), lastSignInAt: F.Later.toISOString(), disabled: true })
        assert.equal(await directory.IsDisabled(F.Principal), true)
    })

    it('answers not disabled and refuses to disable a principal it never recorded', async () =>
    {
        const directory = new OperatorDirectory(new MemoryRecordMap<StaffOperatorRecord>())
        assert.equal(await directory.IsDisabled(F.Other), false)
        assert.equal(await directory.SetDisabled(F.Other, true), false)
        assert.deepEqual(await directory.List(), [])
    })

    it('a sign-in without an operator role records no one new, and sets a recorded operator\'s role to none', async () =>
    {
        const directory = new OperatorDirectory(new MemoryRecordMap<StaffOperatorRecord>())
        assert.equal(await directory.RecordSignIn(F.Principal, F.Email, StaffOperatorRole.None, F.First), undefined)
        assert.deepEqual(await directory.List(), [])
        await directory.RecordSignIn(F.Principal, F.Email, StaffOperatorRole.Full, F.First)
        assert.equal(await directory.RoleOf(F.Principal), StaffOperatorRole.Full)
        await directory.RecordSignIn(F.Principal, F.Email, StaffOperatorRole.None, F.Later)
        assert.equal(await directory.RoleOf(F.Principal), StaffOperatorRole.None)
        assert.equal(await directory.RoleOf(F.Other), StaffOperatorRole.None)
    })

    it('overlapping writes never undo one another (a disable racing a sign-in stays disabled)', async () =>
    {
        const map = new SlowRecordMap()
        const directory = new OperatorDirectory(map)
        await directory.RecordSignIn(F.Principal, F.Email, StaffOperatorRole.Full, F.First)
        await Promise.all([directory.SetDisabled(F.Principal, true), directory.RecordSignIn(F.Principal, F.Email, StaffOperatorRole.Full, F.Later), directory.RecordSignIn(F.Other, F.Email, StaffOperatorRole.Full, F.Later)])
        assert.equal(await directory.IsDisabled(F.Principal), true)
        assert.equal(await directory.RoleOf(F.Principal), StaffOperatorRole.None)
        const stored = await map.Load()
        assert.equal(stored.get(F.Principal)?.disabled, true)
        assert.equal(stored.get(F.Principal)?.lastSignInAt, F.Later.toISOString())
        assert.ok(stored.has(F.Other))
        const reread = new OperatorDirectory(map)
        assert.equal(await reread.IsDisabled(F.Principal), true)
    })

    it('lists the newest sign-in first', async () =>
    {
        const directory = new OperatorDirectory(new MemoryRecordMap<StaffOperatorRecord>())
        await directory.RecordSignIn(F.Principal, F.Email, StaffOperatorRole.Full, F.First)
        await directory.RecordSignIn(F.Other, F.Email, StaffOperatorRole.Full, F.Later)
        assert.deepEqual((await directory.List()).map(r => r.principal), [F.Other, F.Principal])
    })

    SqlTestSessions.Describe('OperatorDirectory in the console database', (makeSession, backend) =>
    {
        it(`${backend}: what one directory writes another reads (the records outlive the process)`, async () =>
        {
            const database = PlatformAdminDatabase.Over(await makeSession())
            const written = new OperatorDirectory(await database.Map<StaffOperatorRecord>(PlatformAdminRegistry.OperatorDirectory))
            await written.RecordSignIn(F.Principal, F.Email, StaffOperatorRole.Full, F.First)
            await written.SetDisabled(F.Principal, true)
            const read = new OperatorDirectory(await database.Map<StaffOperatorRecord>(PlatformAdminRegistry.OperatorDirectory))
            assert.equal(await read.IsDisabled(F.Principal), true)
            assert.deepEqual((await read.List()).map(r => r.email), [F.Email])
        })
    })
})
