import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EntitledOperation } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CustomerApiError, CustomerErrorCode, NotEntitledReason } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { ClientLock } from '../../customer/client-lock.js'
import { ClientUsage } from '../../customer/client-usage.js'
import { ClientRegistry } from '../../client-registry.js'
import { HiveRegistry } from '../../hive-registry.js'
import { PlatformDirectory } from '../../platform-directory.js'
import { TenantRegistry } from '../../tenant-registry.js'
import { TestEntitlements } from '../../tests/test-entitlements.js'
import { OperatorEntitlementGate } from '../operator-entitlement-gate.js'

/** A work the test finishes when it chooses (an operator's slow provisioning). */
class HeldWork
{
    private release: (() => void) | undefined

    public Run(): Promise<void>
    {
        return new Promise<void>(resolve =>
        {
            this.release = resolve
        })
    }

    public Finish(): void
    {
        this.release?.()
    }
}

class GateFixture
{
    public static readonly ClientId = 'acme'
    public static readonly ClientName = 'Acme'
    public static readonly OneTenant = { 'tenants': 1 }
    public static readonly DirPrefix = 'operator-gate-'
    public static readonly ClientsFile = 'clients.json'
    public static readonly TenantsFile = 'tenants.json'
    public static readonly HivesFile = 'hives.json'
    public static readonly PromptMs = 200

    public static async Directory(parent: string): Promise<PlatformDirectory>
    {
        const F = GateFixture
        const directory = new PlatformDirectory(new ClientRegistry(join(parent, F.ClientsFile)), new TenantRegistry(join(parent, F.TenantsFile)),
            new HiveRegistry(join(parent, F.HivesFile)), { List: () => [] })
        await directory.Load()
        await directory.RecordClient({ id: F.ClientId, displayName: F.ClientName })
        return directory
    }

    public static async Within<T>(ms: number, work: Promise<T>): Promise<T>
    {
        let timer: NodeJS.Timeout | undefined
        const late = new Promise<never>((_resolve, reject) =>
        {
            timer = setTimeout(() => reject(new Error(String(ms))), ms)
        })
        try
        {
            return await Promise.race([work, late])
        }
        finally
        {
            clearTimeout(timer)
        }
    }
}

describe('OperatorEntitlementGate', () =>
{
    const F = GateFixture

    it('decides and reserves inside the client lock, then works outside it: the customer side never waits, yet counts the reservation', async () =>
    {
        const parent = mkdtempSync(join(tmpdir(), F.DirPrefix))
        try
        {
            const directory = await F.Directory(parent)
            const statements = new TestEntitlements()
            statements.State(F.ClientId, { Limits: F.OneTenant })
            const lock = new ClientLock()
            const usage = new ClientUsage(directory, { HeldCount: () => 0 })
            const gate = new OperatorEntitlementGate(statements, usage, lock)
            const held = new HeldWork()
            const provisioning = gate.Run(F.ClientId, [EntitledOperation.CreateTenant], () => held.Run())
            await F.Within(F.PromptMs, lock.Run(F.ClientId, async () => undefined))
            assert.equal(await usage.Of(F.ClientId, EntitledOperation.CreateTenant), 1, 'the running provisioning holds the tenant slot')
            await assert.rejects(F.Within(F.PromptMs, gate.Run(F.ClientId, [EntitledOperation.CreateTenant], async () => undefined)),
                (err: unknown) => err instanceof CustomerApiError && err.CustomerCode === CustomerErrorCode.NotEntitled && err.Reason === NotEntitledReason.LimitReached)
            held.Finish()
            await provisioning
            assert.equal(await usage.Of(F.ClientId, EntitledOperation.CreateTenant), 0, 'released when the work ended (it created nothing)')
        }
        finally
        {
            rmSync(parent, { recursive: true, force: true })
        }
    })

    it('a failing work releases its reservation', async () =>
    {
        const parent = mkdtempSync(join(tmpdir(), F.DirPrefix))
        try
        {
            const directory = await F.Directory(parent)
            const statements = new TestEntitlements()
            statements.State(F.ClientId, { Limits: F.OneTenant })
            const usage = new ClientUsage(directory, { HeldCount: () => 0 })
            const gate = new OperatorEntitlementGate(statements, usage, new ClientLock())
            await assert.rejects(gate.Run(F.ClientId, [EntitledOperation.CreateTenant], async () =>
            {
                throw new RangeError(F.ClientId)
            }), RangeError)
            assert.equal(await usage.Of(F.ClientId, EntitledOperation.CreateTenant), 0)
        }
        finally
        {
            rmSync(parent, { recursive: true, force: true })
        }
    })
})
