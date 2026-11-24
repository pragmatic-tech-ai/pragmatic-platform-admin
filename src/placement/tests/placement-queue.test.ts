import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EnvelopeSigner, MessageKind, Participant, PlacementOperation, PlacementRequest, SigningKeyPair } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeClock } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { MemoryRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { PlacementQueue, PlacementQueueStore, type IQueueSequences, type PlacementQueueRecord } from '../placement-queue.js'

class QueueSequences implements IQueueSequences
{
    public Last = 0

    public TakeSequence(_hostId: string): Promise<number>
    {
        this.Last += 1
        return Promise.resolve(this.Last)
    }

    public Get(_hostId: string): { lastSequence?: number }
    {
        return { lastSequence: this.Last }
    }
}

class QueueCases
{
    public static readonly Host = 'hsaaaaaaaaaa'
    public static readonly Other = 'hsbbbbbbbbbb'

    public static async Queue(): Promise<{ Queue: PlacementQueue; Clock: FakeClock; Key: SigningKeyPair }>
    {
        const clock = new FakeClock()
        const key = SigningKeyPair.Generate()
        const store = new PlacementQueueStore(new MemoryRecordMap<PlacementQueueRecord>())
        await store.Load()
        return { Queue: new PlacementQueue(store, new QueueSequences(), new EnvelopeSigner(key, Participant.Platform, clock), () => clock.Now()), Clock: clock, Key: key }
    }

    public static Place(id: string, version: string = '0.1.0-early.20'): PlacementRequest
    {
        return PlacementRequest.Place({ PlacementId: id, Tenant: 'acme', EnrolmentCode: 'pe1-AAAAAAAAAAAAAAAAAAAAAAAAAA', EngineVersion: version, ChartDigest: 'sha256:' + 'a'.repeat(64), HiveHostName: 'acme-abcd.hives.pragmatic-tech.ai' })
    }
}

describe('PlacementQueue', () =>
{
    const C = QueueCases
    it('answers the newest request per placement after the cursor, addressed to the host and signed by the platform', async () =>
    {
        const { Queue } = await C.Queue()
        await Queue.Publish(C.Host, C.Place('pl-a'))
        await Queue.Publish(C.Host, C.Place('pl-b'))
        await Queue.Publish(C.Host, C.Place('pl-a', '0.1.0-early.21'))
        await Queue.Publish(C.Other, C.Place('pl-c'))
        const batch = Queue.After(C.Host, 0, 100)
        assert.deepEqual(batch.Items.map(item => (item.Body as { PlacementId: string }).PlacementId), ['pl-b', 'pl-a'])
        assert.equal((batch.Items[1]?.Body as { EngineVersion: string }).EngineVersion, '0.1.0-early.21')
        assert.ok(batch.Items.every(item => item.Kind === MessageKind.PlacementRequest && item.Audience.Equals(Participant.Host(C.Host))))
        assert.equal(batch.Cursor, 3)
        assert.equal(Queue.After(C.Host, 3, 100).Items.length, 0)
    })

    it('a removal after a place answers the removal only; max bounds the batch and the cursor', async () =>
    {
        const { Queue } = await C.Queue()
        await Queue.Publish(C.Host, C.Place('pl-a'))
        await Queue.Publish(C.Host, C.Place('pl-b'))
        await Queue.Publish(C.Host, PlacementRequest.Remove('pl-a', 'acme'))
        const one = Queue.After(C.Host, 0, 1)
        assert.equal(one.Items.length, 1)
        assert.equal((one.Items[0]?.Body as { PlacementId: string }).PlacementId, 'pl-b')
        const rest = Queue.After(C.Host, one.Cursor, 100)
        assert.equal((rest.Items[0]?.Body as { Operation: string }).Operation, PlacementOperation.Remove)
    })

    it('an unknown cursor answers from the start, never skipping', async () =>
    {
        const { Queue } = await C.Queue()
        await Queue.Publish(C.Host, C.Place('pl-a'))
        assert.equal(Queue.After(C.Host, 42, 100).Items.length, 1)
    })

    it('an expired request is no longer answered and is pruned on the next publish', async () =>
    {
        const { Queue, Clock } = await C.Queue()
        const sequence = await Queue.Publish(C.Host, C.Place('pl-a'))
        assert.equal(Queue.Holds(C.Host, sequence), true)
        Clock.Advance(8 * 24 * 60 * 60 * 1000)
        assert.equal(Queue.Holds(C.Host, sequence), false)
        assert.equal(Queue.After(C.Host, 0, 100).Items.length, 0)
    })
})
