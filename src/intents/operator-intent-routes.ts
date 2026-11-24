import { HttpMethod, JsonApi, RouteAuth, type RequestContext, type RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import { IntentActions, ProtocolDecodeError } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { OperatorRoleClaims } from '../operator-sessions.js'
import type { IntentOutbox } from './intent-outbox.js'
import { IntentPublisher, IntentRefusal, IntentRefusedError } from './intent-publisher.js'
import type { IntentRecord } from './intent-record.js'

/** One intent as the operator portal shows it (no envelope, no signature). */
export type OperatorIntentDto = {
    id: string
    sequence: number
    level: string
    action: Record<string, unknown>
    issuedAt: string
    expiresAt: string
    expired: boolean
    progress: string | null
    failure: string | null
    decision: IntentRecord['decision']
    supersededBy: string | null
    reissues: string | null
    publishedBy: string
}

/** Moves a hive's release selection (PlatformDeploymentRegistry.SelectTarget: for a hive managed by pulls, its intents). */
export interface IReleaseSelection
{
    SelectTarget(hiveId: string, version: string): Promise<void>
}

/**
 * The operator's intents for hives managed by pulls (C3.4), on the operator API: `GET /api/hives/:id/intents` (both
 * operator roles) lists the hive's intents with their progress, decision and expiry; `POST /api/hives/:id/intents`
 * `{ action, lifetimeDays? }` publishes one (operator.full: environments, repairs, hive-key and console-certificate
 * rotations only, else `kind-not-allowed`; component versions come from a release selection, a trust-root rotation
 * from none); `POST /api/intents/:id/reissue` reissues one under a new
 * id (operator.full); `POST /api/hives/:id/release` `{ version }` moves the hive to a release, announced as one
 * component-at-version intent per changed engine component (operator.full). Refusals are `{ error, code }` (IntentRefusedError.Status): `hive-takes-no-intents`,
 * `not-reissuable` and `too-many-open` 409, `malformed` and `kind-not-allowed` 400, an unknown hive or intent 404.
 */
export class OperatorIntentRoutes
{
    public static readonly HiveIntentsPath = '/api/hives/:id/intents'
    public static readonly ReissuePath = '/api/intents/:id/reissue'
    public static readonly HiveReleasePath = '/api/hives/:id/release'
    private static readonly VersionField = 'version'
    private static readonly StatusNoContent = 204
    public static readonly MaxBodyBytes = 16_384
    private static readonly IdParam = 'id'
    private static readonly ActionField = 'action'
    private static readonly LifetimeField = 'lifetimeDays'
    private static readonly ActionPath = 'action'
    private static readonly OperatorPrefix = 'operator:'
    private static readonly StatusOk = 200
    private static readonly StatusCreated = 201

    public constructor(private readonly publisher: IntentPublisher, private readonly outbox: IntentOutbox, private readonly releases: IReleaseSelection)
    {
    }

    public Register(table: RouteTable): void
    {
        const R = OperatorIntentRoutes
        table.Add({ Method: HttpMethod.Get, Pattern: R.HiveIntentsPath, Auth: RouteAuth.Session, AppRole: OperatorRoleClaims.Any, Handler: async ctx => this.Run(ctx, () => this.List(ctx)) })
        table.Add({ Method: HttpMethod.Post, Pattern: R.HiveIntentsPath, Auth: RouteAuth.Session, AppRole: OperatorRoleClaims.Full, BodyLimit: R.MaxBodyBytes, Handler: async ctx => this.Run(ctx, () => this.Publish(ctx)) })
        table.Add({ Method: HttpMethod.Post, Pattern: R.HiveReleasePath, Auth: RouteAuth.Session, AppRole: OperatorRoleClaims.Full, BodyLimit: R.MaxBodyBytes, Handler: async ctx => this.Run(ctx, () => this.SelectRelease(ctx)) })
        table.Add({ Method: HttpMethod.Post, Pattern: R.ReissuePath, Auth: RouteAuth.Session, AppRole: OperatorRoleClaims.Full, Handler: async ctx => this.Run(ctx, () => this.Reissue(ctx)) })
    }

    public Dto(record: IntentRecord): OperatorIntentDto
    {
        return {
            id: record.id, sequence: record.sequence, level: record.level, action: record.action, issuedAt: record.issuedAt, expiresAt: record.expiresAt,
            expired: this.outbox.IsExpired(record), progress: record.progress, failure: record.failure, decision: record.decision,
            supersededBy: record.supersededBy, reissues: record.reissues, publishedBy: record.publishedBy,
        }
    }

    private async List(ctx: RequestContext): Promise<void>
    {
        const R = OperatorIntentRoutes
        const hiveId = ctx.Param(R.IdParam)
        this.publisher.RequireKnown(hiveId)
        ctx.WriteJson(R.StatusOk, { intents: this.outbox.ForHive(hiveId).map(record => this.Dto(record)).reverse() })
    }

    private async Publish(ctx: RequestContext): Promise<void>
    {
        const R = OperatorIntentRoutes
        const body = await JsonApi.ReadJsonObject(ctx.Request, R.MaxBodyBytes)
        let action
        try
        {
            action = IntentActions.Parse(body[R.ActionField], R.ActionPath)
        }
        catch (error)
        {
            if (error instanceof ProtocolDecodeError)
            {
                throw new IntentRefusedError(IntentRefusal.Malformed)
            }
            throw error
        }
        if (!IntentPublisher.ByHand(action))
        {
            throw new IntentRefusedError(IntentRefusal.KindNotAllowed)
        }
        const lifetime = body[R.LifetimeField] ?? IntentPublisher.DefaultLifetimeDays
        if (typeof lifetime !== 'number' || !Number.isInteger(lifetime))
        {
            throw new IntentRefusedError(IntentRefusal.Malformed)
        }
        const record = await this.publisher.Publish(ctx.Param(R.IdParam), action, R.PublishedBy(ctx), lifetime)
        ctx.NoteAudit(record.kind)
        ctx.WriteJson(R.StatusCreated, this.Dto(record))
    }

    private async Reissue(ctx: RequestContext): Promise<void>
    {
        const R = OperatorIntentRoutes
        JsonApi.Drain(ctx.Request)
        const record = await this.publisher.Reissue(ctx.Param(R.IdParam), R.PublishedBy(ctx))
        ctx.NoteAudit(record.reissues ?? record.id)
        ctx.WriteJson(R.StatusCreated, this.Dto(record))
    }

    private async SelectRelease(ctx: RequestContext): Promise<void>
    {
        const R = OperatorIntentRoutes
        const body = await JsonApi.ReadJsonObject(ctx.Request, R.MaxBodyBytes)
        const version = body[R.VersionField]
        if (typeof version !== 'string' || version.length === 0)
        {
            throw new IntentRefusedError(IntentRefusal.Malformed)
        }
        const hive = this.publisher.RequireTakesIntents(ctx.Param(R.IdParam))
        await this.releases.SelectTarget(hive.id, version)
        ctx.NoteAudit(version)
        ctx.Response.writeHead(R.StatusNoContent)
        ctx.Response.end()
    }

    private async Run(ctx: RequestContext, run: () => Promise<void>): Promise<void>
    {
        try
        {
            await run()
        }
        catch (error)
        {
            if (error instanceof IntentRefusedError)
            {
                ctx.WriteJson(error.Status, { error: error.message, code: error.Code })
                return
            }
            throw error
        }
    }

    private static PublishedBy(ctx: RequestContext): string
    {
        return OperatorIntentRoutes.OperatorPrefix + OperatorRoleClaims.PrincipalOf(ctx.RequireSession()).email
    }
}
