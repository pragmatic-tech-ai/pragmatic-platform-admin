import { CacheControl, HttpMethod, type RequestContext } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { HostReportJson, ResourcesJson } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { PlacementRecord } from '../placement/placement-record.js'
import type { HostRecord } from './host-record.js'
import { HostRegistry } from './host-registry.js'

/** Issuing a host code (EnrolmentCodeIssuer.IssueHostCode). */
export interface IHostCodes
{
    IssueHostCode(issuedBy: string): Promise<{ Code: string; ExpiresAt: Date }>
}

/** The hosts and the placements on them. */
export interface IHostRoster
{
    List(): readonly HostRecord[]
}

export interface IHostPlacements
{
    List(): readonly PlacementRecord[]
    HoldingSlotOn(hostId: string): readonly PlacementRecord[]
}

/** One placement as the operator sees it on a host. */
export type HostPlacementRow = {
    id: string
    tenantId: string
    state: string
    label: string | null
    hiveHostName: string | null
    hiveId: string | null
    engineVersion: string | null
    placedEngineVersion: string | null
    failure: string | null
    credentialRotation: number | null
}

/** One host as `GET /api/hosts` answers it. */
export type HostRow = {
    id: string
    machine: string
    clusterKind: string
    meshAddress: string
    agentVersion: string
    keyId: string
    enrolledAt: string
    enrolledBy: string
    /** Whether the scheduler places on it now: its last report is healthy and at most two minutes old. */
    fresh: boolean
    health: string | null
    lastReportAt: string | null
    capacity: ResourcesJson | null
    allocatable: ResourcesJson | null
    hiveSlots: number | null
    freeSlots: number
    placements: HostPlacementRow[]
}

/** The route table's add functions (ControlPlaneHost.Routes): a read admits every operator, a write operator.full. */
export type HostRouteRead = (pattern: string, handler: (ctx: RequestContext) => Promise<void> | void) => void
export type HostRouteWrite = (method: HttpMethod, pattern: string, handler: (ctx: RequestContext) => Promise<void> | void) => void

/**
 * The operator routes of hosts (C5.1): `POST /api/hosts/enrolment-code` (operator.full) issues a host code and answers
 * it once (never stored, never readable again: only its hash is kept), `GET /api/hosts` lists every host with its
 * capacity, free slots, last report and the placements on it. Both answer no-store.
 */
export class HostRoutes
{
    public static readonly HostsPath = '/api/hosts'
    public static readonly EnrolmentCodePath = '/api/hosts/enrolment-code'
    private static readonly StatusOk = 200
    private static readonly StatusCreated = 201
    private static readonly EmailClaim = 'email'
    private static readonly OperatorKeyPrefix = 'operator:'

    public constructor(private readonly hosts: IHostRoster, private readonly placements: IHostPlacements, private readonly codes: IHostCodes, private readonly now: () => Date = () => new Date())
    {
    }

    public Register(read: HostRouteRead, write: HostRouteWrite): void
    {
        const H = HostRoutes
        read(H.HostsPath, ctx => this.HandleList(ctx))
        write(HttpMethod.Post, H.EnrolmentCodePath, ctx => this.HandleIssue(ctx))
    }

    /** Every host as the operator sees it, newest enrolment first. */
    public Rows(): HostRow[]
    {
        const now = this.now()
        const placements = this.placements.List()
        return this.hosts.List()
            .slice()
            .sort((a, b) => b.enrolledAt.localeCompare(a.enrolledAt))
            .map(host => HostRoutes.RowOf(host, placements.filter(placement => placement.hostId === host.id), this.placements.HoldingSlotOn(host.id).length, now))
    }

    private HandleList(ctx: RequestContext): void
    {
        CacheControl.NoStore(ctx.Response)
        ctx.WriteJson(HostRoutes.StatusOk, this.Rows())
    }

    private async HandleIssue(ctx: RequestContext): Promise<void>
    {
        const H = HostRoutes
        const session = ctx.RequireSession()
        const issuedBy = H.OperatorKeyPrefix + (session.Claims.First(H.EmailClaim) ?? session.Subject)
        const issued = await this.codes.IssueHostCode(issuedBy)
        CacheControl.NoStore(ctx.Response)
        ctx.WriteJson(H.StatusCreated, { code: issued.Code, expiresAt: issued.ExpiresAt.toISOString() })
    }

    private static RowOf(host: HostRecord, placements: readonly PlacementRecord[], holding: number, now: Date): HostRow
    {
        const report: HostReportJson | undefined = host.lastReport
        return {
            id: host.id,
            machine: host.machine,
            clusterKind: host.clusterKind,
            meshAddress: host.meshAddress,
            agentVersion: host.agentVersion,
            keyId: host.keyId,
            enrolledAt: host.enrolledAt,
            enrolledBy: host.enrolledBy,
            fresh: HostRegistry.IsFresh(host, now),
            health: report?.Health ?? null,
            lastReportAt: host.lastReportAt ?? null,
            capacity: report?.Capacity ?? null,
            allocatable: report?.Allocatable ?? null,
            hiveSlots: report?.HiveSlots ?? null,
            freeSlots: HostRegistry.FreeSlots(host, holding),
            placements: placements.map(placement => ({
                id: placement.id,
                tenantId: placement.tenantId,
                state: placement.state,
                label: placement.label ?? null,
                hiveHostName: placement.hiveHostName ?? null,
                hiveId: placement.hiveId ?? null,
                engineVersion: placement.engineVersion ?? null,
                placedEngineVersion: placement.placedEngineVersion ?? null,
                failure: placement.failure ?? placement.upgradeFailure ?? null,
                credentialRotation: placement.credentialRotation ?? null,
            })),
        }
    }
}
