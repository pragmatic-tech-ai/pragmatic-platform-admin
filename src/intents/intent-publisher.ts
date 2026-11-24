import { randomBytes } from 'node:crypto'
import { EnvelopeSigner, Intent, IntentActionKind, IntentProgress, MessageKind, Participant, RotationSubject, type HiveLevel, type IntentAction } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { PlatformHiveRecords, type PlatformHiveRecord } from '../platform-records.js'
import type { IntentOutbox } from './intent-outbox.js'
import type { IntentRecord } from './intent-record.js'
import type { IIntentSequences } from './sql-intent-sequences.js'

/** The codes an intent route or call refuses with. */
export enum IntentRefusal
{
    /** Standalone and Hosted hives, records without a level, push-installed and left hives take no intents. */
    HiveTakesNoIntents = 'hive-takes-no-intents',
    Malformed = 'malformed',
    UnknownHive = 'unknown-hive',
    UnknownIntent = 'unknown-intent',
    /** Only an expired or failed intent is reissued (one the hive could still apply never is). */
    NotReissuable = 'not-reissuable',
    /** A kind an operator may not publish by hand: component versions come from a release selection only, a trust-root
     *  rotation from the platform's own signing-key rotation only. */
    KindNotAllowed = 'kind-not-allowed',
    /** The hive already holds as many open intents as it keeps. */
    TooManyOpen = 'too-many-open',
    /** An open request for the same environment asks for another purpose. */
    ConflictingRequest = 'conflicting-request',
}

/** An intent request refused with a code (the operator routes and the customer API answer it). */
export class IntentRefusedError extends Error
{
    private static readonly ErrorName = 'IntentRefusedError'
    private static readonly Texts: Readonly<Record<IntentRefusal, string>> = {
        [IntentRefusal.HiveTakesNoIntents]: 'This hive is not managed by pulled intents.',
        [IntentRefusal.Malformed]: 'The intent is not valid.',
        [IntentRefusal.UnknownHive]: 'No such hive.',
        [IntentRefusal.UnknownIntent]: 'No such intent.',
        [IntentRefusal.NotReissuable]: 'Only an expired or failed intent can be reissued.',
        [IntentRefusal.KindNotAllowed]: 'This kind of intent is not published by hand.',
        [IntentRefusal.TooManyOpen]: 'This hive already has the most open intents it keeps.',
        [IntentRefusal.ConflictingRequest]: 'An open request for this environment asks for another purpose.',
    }
    private static readonly Statuses: Readonly<Record<IntentRefusal, number>> = {
        [IntentRefusal.HiveTakesNoIntents]: 409,
        [IntentRefusal.Malformed]: 400,
        [IntentRefusal.UnknownHive]: 404,
        [IntentRefusal.UnknownIntent]: 404,
        [IntentRefusal.NotReissuable]: 409,
        [IntentRefusal.KindNotAllowed]: 400,
        [IntentRefusal.TooManyOpen]: 409,
        [IntentRefusal.ConflictingRequest]: 409,
    }

    /** The HTTP status this refusal answers with. */
    public get Status(): number
    {
        return IntentRefusedError.Statuses[this.Code]
    }

    public constructor(public readonly Code: IntentRefusal)
    {
        super(IntentRefusedError.Texts[Code])
        this.name = IntentRefusedError.ErrorName
    }
}

/** Where the publisher reads the hive. */
export interface IIntentHives
{
    GetHive(id: string): PlatformHiveRecord | undefined
}

/**
 * Publishes signed intents for hives managed by pulls (C3.4): the hive's recorded level, a fresh id (`in` + 12 base32
 * characters), the hive's next sequence number from IIntentSequences (unique across processes, above every cursor the
 * hive pulled after), a lifetime of 1 to 30 days (7 by default), signed under the platform signing key and kept with its
 * envelope for the hive's pulls. A hive keeps at most MaxOpen open intents. Reissue signs the same action again under a
 * new id for the same lifetime, only once the old one expired or failed, and marks it superseded.
 */
export class IntentPublisher
{
    public static readonly IdPrefix = 'in'
    public static readonly DefaultLifetimeDays = 7
    public static readonly MaxLifetimeDays = 30
    public static readonly MaxOpen = 50
    private static readonly IdCharacters = 12
    private static readonly Alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
    private static readonly CharacterMask = 31
    private static readonly DayMs = 86_400_000
    private static readonly EnvironmentField = 'Environment'
    private static readonly PurposeField = 'Purpose'
    private static readonly ReissuableProgress: ReadonlySet<IntentProgress> = new Set([IntentProgress.Failed, IntentProgress.Expired])
    /** One queue per hive: every check-then-publish of a hive runs alone (with the sequence table's conditional write). */
    private readonly queues = new Map<string, Promise<unknown>>()

    public constructor(private readonly outbox: IntentOutbox, private readonly hives: IIntentHives, private readonly signer: EnvelopeSigner, private readonly sequences: IIntentSequences)
    {
    }

    /** Whether an operator may publish this kind by hand (environments, repairs, hive-key and console-certificate rotations). */
    public static ByHand(action: IntentAction): boolean
    {
        if (action.Kind === IntentActionKind.ComponentAtVersion)
        {
            return false
        }
        return action.Kind !== IntentActionKind.Rotate || action.Subject !== RotationSubject.TrustRoot
    }

    public Publish(hiveId: string, action: IntentAction, publishedBy: string, lifetimeDays: number = IntentPublisher.DefaultLifetimeDays): Promise<IntentRecord>
    {
        return this.ForHive(hiveId, () => this.PublishNow(hiveId, action, publishedBy, lifetimeDays * IntentPublisher.DayMs, null))
    }

    /**
     * Runs `work` alone among the hive's publishes, reissues and the checks callers make before publishing (the
     * request-environment dedupe, the rollout's open-intent check), so no check is stale by the time it publishes.
     */
    public ForHive<T>(hiveId: string, work: () => Promise<T>): Promise<T>
    {
        const next = (this.queues.get(hiveId) ?? Promise.resolve()).then(work)
        const settled = next.catch(() => undefined)
        this.queues.set(hiveId, settled)
        void settled.then(() =>
        {
            if (this.queues.get(hiveId) === settled)
            {
                this.queues.delete(hiveId)
            }
        })
        return next
    }

    /** As Publish, for a caller already inside ForHive. */
    public PublishInTurn(hiveId: string, action: IntentAction, publishedBy: string): Promise<IntentRecord>
    {
        return this.PublishNow(hiveId, action, publishedBy, IntentPublisher.DefaultLifetimeDays * IntentPublisher.DayMs, null)
    }

    /** A new intent with the same action and lifetime as `intentId` (expired or failed); the old one is marked superseded. */
    public async Reissue(intentId: string, publishedBy: string): Promise<IntentRecord>
    {
        const old = this.outbox.Get(intentId)
        if (old === undefined)
        {
            throw new IntentRefusedError(IntentRefusal.UnknownIntent)
        }
        // In the hive's queue, so two operators reissuing the same intent never make two live copies.
        return this.ForHive(old.hiveId, () => this.ReissueNow(intentId, publishedBy))
    }

    private async ReissueNow(intentId: string, publishedBy: string): Promise<IntentRecord>
    {
        const old = this.outbox.Get(intentId)
        if (old === undefined)
        {
            throw new IntentRefusedError(IntentRefusal.UnknownIntent)
        }
        if (!this.CanReissue(old))
        {
            throw new IntentRefusedError(IntentRefusal.NotReissuable)
        }
        const action = Intent.Parse({ IntentId: old.id, Level: old.level, Action: old.action }).Action
        const fresh = await this.PublishNow(old.hiveId, action, publishedBy, Date.parse(old.expiresAt) - Date.parse(old.issuedAt), old.id)
        await this.outbox.Update(old.id, current => ({ ...current, supersededBy: fresh.id }))
        return fresh
    }

    /**
     * The hive's open create-environment intent for `environment`, when there is one; one asking for another purpose is
     * refused `conflicting-request` (a repeated request answers the open intent, a different one is not hidden in it).
     */
    public OpenCreateOf(hiveId: string, environment: string, purpose: string): IntentRecord | undefined
    {
        const P = IntentPublisher
        const open = this.outbox.OpenForHive(hiveId).find(record => record.kind === IntentActionKind.CreateEnvironment && record.action[P.EnvironmentField] === environment)
        if (open !== undefined && open.action[P.PurposeField] !== purpose)
        {
            throw new IntentRefusedError(IntentRefusal.ConflictingRequest)
        }
        return open
    }

    /** Marks `intentId` superseded by `byId` as it is now (an older open intent a newer one replaces). */
    public async Supersede(intentId: string, byId: string): Promise<void>
    {
        await this.outbox.Update(intentId, current => current.supersededBy === null ? { ...current, supersededBy: byId } : current)
    }

    /** The hive, when it exists; `unknown-hive` otherwise. */
    public RequireKnown(hiveId: string): PlatformHiveRecord
    {
        const hive = this.hives.GetHive(hiveId)
        if (hive === undefined)
        {
            throw new IntentRefusedError(IntentRefusal.UnknownHive)
        }
        return hive
    }

    /** The hive, when it takes intents; refused otherwise. */
    public RequireTakesIntents(hiveId: string): PlatformHiveRecord
    {
        const hive = this.RequireKnown(hiveId)
        if (!PlatformHiveRecords.TakesIntents(hive))
        {
            throw new IntentRefusedError(IntentRefusal.HiveTakesNoIntents)
        }
        return hive
    }

    private CanReissue(record: IntentRecord): boolean
    {
        if (record.supersededBy !== null)
        {
            return false
        }
        if (record.progress !== null && IntentPublisher.ReissuableProgress.has(record.progress))
        {
            return true
        }
        return record.progress !== IntentProgress.Applied && record.progress !== IntentProgress.Rejected && this.outbox.IsExpired(record)
    }

    private async PublishNow(hiveId: string, action: IntentAction, publishedBy: string, lifetimeMs: number, reissues: string | null): Promise<IntentRecord>
    {
        const P = IntentPublisher
        if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < P.DayMs || lifetimeMs > P.MaxLifetimeDays * P.DayMs)
        {
            throw new IntentRefusedError(IntentRefusal.Malformed)
        }
        const hive = this.RequireTakesIntents(hiveId)
        if (this.outbox.OpenForHive(hive.id).length >= P.MaxOpen)
        {
            throw new IntentRefusedError(IntentRefusal.TooManyOpen)
        }
        const level = hive.level as string as HiveLevel
        const id = this.NewId()
        const sequence = await this.sequences.Next(hive.id, this.outbox.MaxSequence(hive.id))
        const envelope = this.signer.Sign(MessageKind.Intent, Participant.Hive(hive.id), Intent.Create(id, level, action), lifetimeMs)
        const record: IntentRecord = {
            id,
            hiveId: hive.id,
            sequence,
            level,
            kind: action.Kind,
            action: action.ToJson(),
            envelope: envelope.Encode(),
            digest: envelope.Digest,
            issuedAt: envelope.IssuedAt.toISOString(),
            expiresAt: envelope.ExpiresAt.toISOString(),
            publishedBy,
            progress: null,
            failure: null,
            decision: null,
            supersededBy: null,
            reissues,
        }
        await this.outbox.Add(record)
        return record
    }

    private NewId(): string
    {
        const P = IntentPublisher
        for (;;)
        {
            const id = P.IdPrefix + [...randomBytes(P.IdCharacters)].map(byte => P.Alphabet[byte & P.CharacterMask] as string).join('')
            if (this.outbox.Get(id) === undefined)
            {
                return id
            }
        }
    }
}
