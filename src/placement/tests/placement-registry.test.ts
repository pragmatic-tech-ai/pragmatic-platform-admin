import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CustomerIds } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { MemoryRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { PlacementRegistry } from '../placement-registry.js'
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
        assert.equal(registry.OutstandingFor(C.ClientId, new Date()), 1)
    })
})
