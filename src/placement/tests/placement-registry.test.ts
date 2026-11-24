import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CustomerIds } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { MemoryRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { PlacementFailure } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { PlacementNotOpenError, PlacementRegistry } from '../placement-registry.js'
import { PlacementState, PlacementStore, type PlacementRecord } from '../placement-record.js'

class PlacementCases
{
    public static readonly ClientId = 'acme'
    public static readonly OtherClient = 'globex'
    public static readonly TenantA = 'acme-main'
    public static readonly TenantB = 'acme-second'
    public static readonly RequestedBy = 'subject-key'
}

describe('PlacementRegistry', () =>
{
    const C = PlacementCases
    it('records a requested placement with a hive-id-shaped id', async () =>
    {
        const store = new PlacementStore(new MemoryRecordMap<PlacementRecord>())
        await store.Load()
        const registry = new PlacementRegistry(store)
        const placement = await registry.Request(C.ClientId, C.TenantA, C.RequestedBy)
        assert.equal(placement.state, PlacementState.Requested)
        assert.match(placement.id, CustomerIds.HiveIdPattern)
        assert.ok(placement.id.startsWith(PlacementRegistry.IdPrefix))
        assert.deepEqual(store.Get(placement.id), placement)
    })

    it('moves only from the state a move starts from: requested → scheduled → placed → removing → removed', async () =>
    {
        const store = new PlacementStore(new MemoryRecordMap<PlacementRecord>())
        await store.Load()
        const registry = new PlacementRegistry(store)
        const placement = await registry.Request(C.ClientId, C.TenantA, C.RequestedBy)
        await assert.rejects(registry.MarkPlaced(placement.id, { host: 'h.mesh.test', port: 16444 }), PlacementNotOpenError)
        const schedule = { HostId: 'hsaaaaaaaaaa', Label: 'acme-main-abcd', HiveHostName: 'acme-main-abcd.hives.pragmatic-tech.ai', EngineVersion: '0.1.0-early.20', ChartDigest: 'sha256:' + 'a'.repeat(64) }
        const scheduled = await registry.Schedule(placement.id, schedule)
        assert.equal(scheduled.version, 1)
        await assert.rejects(registry.Schedule(placement.id, schedule), PlacementNotOpenError)
        await assert.rejects(registry.Cancel(placement.id), PlacementNotOpenError)
        const placed = await registry.MarkPlaced(placement.id, { host: 'h.mesh.test', port: 16444 })
        assert.equal(placed.placedEngineVersion, '0.1.0-early.20')
        const upgraded = await registry.Upgrade(placement.id, '0.1.0-early.21', 'sha256:' + 'b'.repeat(64))
        assert.equal(upgraded.version, 2)
        assert.equal(upgraded.placedEngineVersion, '0.1.0-early.20')
        assert.equal((await registry.MarkFailed(placement.id, PlacementFailure.EngineInstallFailed)).state, PlacementState.Placed, 'a failed upgrade keeps the hive placed')
        assert.equal((await registry.BeginRemoval(placement.id)).state, PlacementState.Removing)
        assert.equal((await registry.MarkRemoved(placement.id)).state, PlacementState.Removed)
        await assert.rejects(registry.BeginRemoval(placement.id), PlacementNotOpenError)
        assert.equal(registry.HoldingSlotOn('hsaaaaaaaaaa').length, 0)
    })

    it('open placements count per client and filter per tenant', async () =>
    {
        const store = new PlacementStore(new MemoryRecordMap<PlacementRecord>())
        await store.Load()
        const registry = new PlacementRegistry(store)
        await registry.Request(C.ClientId, C.TenantA, C.RequestedBy)
        const placed = await registry.Request(C.ClientId, C.TenantB, C.RequestedBy)
        await registry.Request(C.OtherClient, C.TenantA, C.RequestedBy)
        assert.equal(registry.OutstandingFor(C.ClientId, new Date()), 2)
        assert.equal(registry.OpenFor(C.ClientId, C.TenantB).length, 1)
        await store.Put({ ...placed, state: PlacementState.Placed })
        assert.equal(registry.OutstandingFor(C.ClientId, new Date()), 2, 'placed, no hive enrolled from it yet: still reserved')
        await store.Put({ ...placed, state: PlacementState.Placed, hiveId: 'hvaaaaaaaaaa' })
        assert.equal(registry.OutstandingFor(C.ClientId, new Date()), 1, 'its hive counts instead')
        await store.Put({ ...placed, state: PlacementState.Failed })
        assert.equal(registry.OutstandingFor(C.ClientId, new Date()), 1, 'a failed placement holds nothing')
    })
})
