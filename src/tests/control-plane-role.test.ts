import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { join, resolve } from 'node:path'
import { AllRoleRetiredError, ControlPlaneRole, ControlPlaneRoleInvalidError, ControlPlaneRoles, ControlPlaneStart, EdgeRoleRefusedError, type IControlPlaneListenerStarts } from '../control-plane-role.js'
import { ControlPlaneServer } from '../server.js'

/** Records which listeners the start sequence asked for, in order. */
class RecordingListeners implements IControlPlaneListenerStarts
{
    public static readonly Operator = 'operator'
    public static readonly Tenant = 'tenant'
    public static readonly Internal = 'internal'

    public readonly Started: string[] = []

    public async StartOperatorHost(): Promise<void>
    {
        this.Started.push(RecordingListeners.Operator)
    }

    public async StartInternalApi(): Promise<void>
    {
        this.Started.push(RecordingListeners.Internal)
    }

    public async StartTenantPlane(): Promise<void>
    {
        this.Started.push(RecordingListeners.Tenant)
    }
}

describe('control-plane start sequence', () =>
{
    it('starts the operator host, then the internal API, then the tenant plane (never an agent channel: the edge serves it)', async () =>
    {
        const R = RecordingListeners
        const listeners = new R()
        await new ControlPlaneStart().Run(listeners)
        assert.deepEqual(listeners.Started, [R.Operator, R.Internal, R.Tenant])
    })
})

describe('control-plane role', () =>
{
    it('defaults to admin when the variable is unset or blank', () =>
    {
        assert.equal(ControlPlaneRoles.Of({}), ControlPlaneRole.Admin)
        assert.equal(ControlPlaneRoles.Of({ PRAGMATIC_CONTROL_PLANE_ROLE: '' }), ControlPlaneRole.Admin)
        assert.doesNotThrow(() => ControlPlaneRoles.RequireConsole(ControlPlaneRoles.Of({ PRAGMATIC_CONTROL_PLANE_ROLE: 'admin' })))
    })

    it('edge is recognised but refused: the edge runs its own entry, never the console', () =>
    {
        const role = ControlPlaneRoles.Of({ PRAGMATIC_CONTROL_PLANE_ROLE: 'edge' })
        assert.equal(role, ControlPlaneRole.Edge)
        assert.throws(() => ControlPlaneRoles.RequireConsole(role), (e: Error) => e instanceof EdgeRoleRefusedError && /pragmatic-platform-edged/.test(e.message))
    })

    it('the retired all is recognised but refused, naming what replaced it', () =>
    {
        const role = ControlPlaneRoles.Of({ PRAGMATIC_CONTROL_PLANE_ROLE: 'all' })
        assert.equal(role, ControlPlaneRole.All)
        assert.throws(() => ControlPlaneRoles.RequireConsole(role), (e: Error) =>
            e instanceof AllRoleRetiredError && /PRAGMATIC_CONTROL_PLANE_ROLE=all is retired/.test(e.message) && /role admin/.test(e.message) && /pragmatic-platform-edged/.test(e.message))
    })

    it('an unknown role throws a typed error naming the variable and the accepted role only', () =>
    {
        assert.throws(() => ControlPlaneRoles.Of({ PRAGMATIC_CONTROL_PLANE_ROLE: 'sneaky-value' }), (err: unknown) =>
        {
            assert.ok(err instanceof ControlPlaneRoleInvalidError)
            assert.match(err.message, /PRAGMATIC_CONTROL_PLANE_ROLE must be one of: admin$/)
            assert.doesNotMatch(err.message, /sneaky-value/)
            return true
        })
    })
})

describe('ControlPlaneServer.TenantPortalRootOf', () =>
{
    const Here = join('R:', 'pragmatic-platform-admin', 'src')

    it('serves the co-hosted tenant plane from PRAGMATIC_TENANT_PORTAL_DIR when set (resolved)', () =>
    {
        assert.equal(ControlPlaneServer.TenantPortalRootOf({ PRAGMATIC_TENANT_PORTAL_DIR: join('T:', 'tenant-portal', 'dist') }, Here), resolve(join('T:', 'tenant-portal', 'dist')))
    })

    it('falls back to tenant-portal/dist beside the compiled control plane when unset or blank', () =>
    {
        const fallback = join(Here, '..', 'tenant-portal', 'dist')
        assert.equal(ControlPlaneServer.TenantPortalRootOf({}, Here), fallback)
        assert.equal(ControlPlaneServer.TenantPortalRootOf({ PRAGMATIC_TENANT_PORTAL_DIR: ' ' }, Here), fallback)
    })
})
