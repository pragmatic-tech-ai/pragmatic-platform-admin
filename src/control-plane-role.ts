/**
 * Which process the console is asked to be (`PRAGMATIC_CONTROL_PLANE_ROLE`). `admin` (the default and the image's value)
 * runs the operator host, the internal API for the edge and the tenant plane. The agent channel is the platform edge's
 * (bin/pragmatic-platform-edged, the pragmatic-platform-edge image), which answers through that internal API. `edge` and
 * the retired `all` (the single dev process that also served the agent channel) are recognised only to be refused, so a
 * stale unit asking the console for either fails loudly.
 */
export enum ControlPlaneRole
{
    Admin = 'admin',
    Edge = 'edge',
    All = 'all',
}

/** Starts each listener a composed console holds, in ControlPlaneStart's order. */
export interface IControlPlaneListenerStarts
{
    StartOperatorHost(): Promise<void>
    /** Admin's internal API for the edge (started only when PRAGMATIC_ADMIN_INTERNAL_PORT is set). */
    StartInternalApi(): Promise<void>
    StartTenantPlane(): Promise<void>
}

/** The role variable holds a value that is not a known role (the value itself is never echoed). */
export class ControlPlaneRoleInvalidError extends Error
{
    private static readonly ErrorName = 'ControlPlaneRoleInvalidError'
    private static readonly MessagePrefix = 'PRAGMATIC_CONTROL_PLANE_ROLE must be one of: '
    private static readonly Separator = ', '

    public constructor(allowed: readonly string[])
    {
        super(ControlPlaneRoleInvalidError.MessagePrefix + allowed.join(ControlPlaneRoleInvalidError.Separator))
        this.name = ControlPlaneRoleInvalidError.ErrorName
    }
}

/** The console was asked to run the edge, which has its own entry. */
export class EdgeRoleRefusedError extends Error
{
    private static readonly ErrorName = 'EdgeRoleRefusedError'
    private static readonly MessageText = '=edge: the platform edge runs bin/pragmatic-platform-edged, not the console'

    public constructor(envVar: string)
    {
        super(envVar + EdgeRoleRefusedError.MessageText)
        this.name = EdgeRoleRefusedError.ErrorName
    }
}

/** The console was asked for the retired single dev process. */
export class AllRoleRetiredError extends Error
{
    private static readonly ErrorName = 'AllRoleRetiredError'
    private static readonly MessageText = '=all is retired: the console runs role admin, and the platform edge (bin/pragmatic-platform-edged) serves the agent channel'

    public constructor(envVar: string)
    {
        super(envVar + AllRoleRetiredError.MessageText)
        this.name = AllRoleRetiredError.ErrorName
    }
}

export class ControlPlaneRoles
{
    public static readonly EnvVar = 'PRAGMATIC_CONTROL_PLANE_ROLE'
    public static readonly Known: readonly ControlPlaneRole[] = Object.values(ControlPlaneRole)
    /** The roles the console runs as. */
    public static readonly Accepted: readonly ControlPlaneRole[] = [ControlPlaneRole.Admin]

    /** Pure: the role named by the environment; unset or blank is `admin`. */
    public static Of(env: NodeJS.ProcessEnv): ControlPlaneRole
    {
        const raw = env[ControlPlaneRoles.EnvVar]
        if (raw === undefined || raw === '')
        {
            return ControlPlaneRole.Admin
        }
        const role = ControlPlaneRoles.Known.find(r => r === raw)
        if (role === undefined)
        {
            throw new ControlPlaneRoleInvalidError(ControlPlaneRoles.Accepted)
        }
        return role
    }

    /** Refuses `edge` (it has its own entry) and the retired `all`: the console is role `admin` only. */
    public static RequireConsole(role: ControlPlaneRole): void
    {
        if (role === ControlPlaneRole.Edge)
        {
            throw new EdgeRoleRefusedError(ControlPlaneRoles.EnvVar)
        }
        if (role === ControlPlaneRole.All)
        {
            throw new AllRoleRetiredError(ControlPlaneRoles.EnvVar)
        }
    }
}

/** The start sequence of the console: operator host, internal API, then tenant plane. */
export class ControlPlaneStart
{
    public async Run(listeners: IControlPlaneListenerStarts): Promise<void>
    {
        await listeners.StartOperatorHost()
        await listeners.StartInternalApi()
        await listeners.StartTenantPlane()
    }
}
