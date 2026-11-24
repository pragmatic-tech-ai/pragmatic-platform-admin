import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Participant } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeClock } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { SqlNonceLedger } from '../sql-nonce-ledger.js'

class NonceCases
{
    public static readonly Hive = Participant.Hive('hvabcdefghij')
    public static readonly Other = Participant.Hive('hvklmnopqrst')
    public static readonly Nonce = 'n0nce-n0nce-n0nce-n0nce'
    public static readonly Claimers = 8
    public static readonly MinuteMs = 60_000

    public static Later(clock: FakeClock, minutes: number): Date
    {
        return new Date(clock.Now().getTime() + minutes * NonceCases.MinuteMs)
    }
}

describe('SqlNonceLedger', () =>
{
    SqlTestSessions.Describe('SqlNonceLedger', (makeSession, backend) =>
    {
        it(`${backend}: a nonce is claimed once per issuer`, async () =>
        {
            const clock = new FakeClock()
            const ledger = await SqlNonceLedger.Open(await makeSession(), clock)
            assert.equal(await ledger.Claim(NonceCases.Hive, NonceCases.Nonce, NonceCases.Later(clock, 5)), true)
            assert.equal(await ledger.Claim(NonceCases.Hive, NonceCases.Nonce, NonceCases.Later(clock, 5)), false)
            assert.equal(await ledger.Claim(NonceCases.Other, NonceCases.Nonce, NonceCases.Later(clock, 5)), true)
        })

        it(`${backend}: expired rows are swept`, async () =>
        {
            const clock = new FakeClock()
            const ledger = await SqlNonceLedger.Open(await makeSession(), clock)
            await ledger.Claim(NonceCases.Hive, NonceCases.Nonce, NonceCases.Later(clock, 5))
            await ledger.Claim(NonceCases.Other, NonceCases.Nonce, NonceCases.Later(clock, 20))
            assert.equal(await ledger.Size(), 2)
            clock.Advance(10 * NonceCases.MinuteMs)
            assert.equal(await ledger.Claim(NonceCases.Hive, NonceCases.Nonce, NonceCases.Later(clock, 5)), true, 'an expired nonce no longer blocks')
            assert.equal(await ledger.Size(), 2)
            clock.Advance(30 * NonceCases.MinuteMs)
            await ledger.Claim(NonceCases.Hive, 'another-nonce-another-n', NonceCases.Later(clock, 5))
            assert.equal(await ledger.Size(), 1)
        })
    })

    SqlTestSessions.DescribeLive('SqlNonceLedger', makeDatabase =>
    {
        it('live: a nonce is claimed once across two ledger instances (8 concurrent claimers, one wins)', async () =>
        {
            const database = await makeDatabase()
            const clock = new FakeClock()
            const first = await SqlNonceLedger.Open(database.Session(), clock)
            const second = await SqlNonceLedger.Open(database.Session(), clock)
            const claims = Array.from({ length: NonceCases.Claimers }, (_, i) => (i % 2 === 0 ? first : second).Claim(NonceCases.Hive, NonceCases.Nonce, NonceCases.Later(clock, 5)))
            const won = (await Promise.all(claims)).filter(Boolean)
            assert.equal(won.length, 1)
        })
    })
})
