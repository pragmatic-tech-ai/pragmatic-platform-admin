import { HiveLevel as CustomerHiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import {
    AgentExchangeRefusal, HiveEnrolmentRequest, HiveEnrolmentResponse, MessageKind,
    type HiveLevel, type IBodyDecoder, type SigningPublicKey, type VerifiedMessage,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { EnrolmentCodeRefusal, EnrolmentCodeRefusedError, type EnrolmentCodeExpectation } from '../enrolment/enrolment-code-issuer.js'
import { EnrolmentAgentKind, type EnrolmentCodeRecord } from '../enrolment/enrolment-code-record.js'
import type { EnrolledHiveInput } from '../platform-directory.js'
import { PlatformHiveRecords, type PlatformHiveRecord } from '../platform-records.js'
import type { IPlacementEnrolments } from '../placement/placement-hive-link.js'
import type { HiveIdAllocator } from './hive-id-allocator.js'
import { AgentAnswer, AgentExchangeRefusedError, type IAgentMessageHandler } from './platform-agent-exchange.js'

/** Redeeming the one-time code (D4's EnrolmentCodeIssuer). */
export interface IEnrolmentCodes
{
    Redeem(code: string, expect: EnrolmentCodeExpectation): Promise<EnrolmentCodeRecord>
    /** What the code is for, without spending it (undefined: unknown). */
    Peek(code: string): Promise<EnrolmentCodeRecord | undefined>
}

/** Where enrolled hives are recorded (PlatformDirectory). */
export interface IEnrolledHives
{
    GetHive(id: string): PlatformHiveRecord | undefined
    HiveByKeyId(keyId: string): PlatformHiveRecord | undefined
    HasTenant(id: string): boolean
    EnrolHive(input: EnrolledHiveInput): Promise<PlatformHiveRecord>
    ReEnrolHive(id: string, input: EnrolledHiveInput): Promise<PlatformHiveRecord>
}

/** Whether a hive has ever reported (the observation registry). */
export interface IHiveReportHistory
{
    LatestRecord(hiveId: string): unknown
}

export interface HiveEnrolmentHandlerParts
{
    Codes: IEnrolmentCodes
    Hives: IEnrolledHives
    Reports: IHiveReportHistory
    Ids: HiveIdAllocator
    TrustRoot: SigningPublicKey
    ChannelUrl: string
    /** Hosted placements (C5.1): a hive enrolled with a placement's code is linked to it. Without it such a code is refused. */
    Placements?: IPlacementEnrolments
}

/**
 * "Connect this hive" on the platform (C3.3): a self-signed HiveEnrolmentRequest (its nonce already claimed, so a
 * replayed request never reaches the code) redeems the one-time code for exactly the tenant, level and agent kind it
 * was issued for, records the hive by its public key alone and answers the hive id, tenant, level, trust root and
 * channel URL. A key already registered to a hive is refused `key-registered` before the code is touched, except the
 * one recovery: the agent restarted after the platform recorded it but before it stored the answer (the hive is the
 * same tenant and level and has never reported), where a new valid code answers that same hive again and no second
 * record is made. Enrolments are taken one at a time, so two requests for one key cannot both record a hive. A hosted
 * hive's code (C5.1) names its placement: the hive is linked to it (and attached to its cluster once placed); a code
 * whose placement was removed or cancelled enrols nothing (`mismatch`).
 */
export class HiveEnrolmentHandler implements IAgentMessageHandler<HiveEnrolmentRequest>
{
    public readonly Kind = MessageKind.HiveEnrolmentRequest
    public readonly Decoder: IBodyDecoder<HiveEnrolmentRequest> = HiveEnrolmentRequest
    private static readonly InvalidCodeReasons: ReadonlySet<EnrolmentCodeRefusal> = new Set([EnrolmentCodeRefusal.Unknown, EnrolmentCodeRefusal.Used, EnrolmentCodeRefusal.Expired])
    private turn: Promise<unknown> = Promise.resolve()

    public constructor(private readonly parts: HiveEnrolmentHandlerParts)
    {
    }

    public KeyOf(body: HiveEnrolmentRequest): SigningPublicKey
    {
        return HiveEnrolmentRequest.KeyOf(body)
    }

    public Handle(message: VerifiedMessage<HiveEnrolmentRequest>): Promise<AgentAnswer>
    {
        const next = this.turn.then(() => this.Enrol(message))
        this.turn = next.catch(() => undefined)
        return next
    }

    private async Enrol(message: VerifiedMessage<HiveEnrolmentRequest>): Promise<AgentAnswer>
    {
        const request = message.Body
        const level = HiveEnrolmentHandler.CustomerLevelOf(request.Level)
        const existing = this.parts.Hives.HiveByKeyId(request.PublicKey.KeyId)
        if (existing !== undefined && !this.IsUnconfirmed(existing, request.Tenant, level))
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.KeyRegistered)
        }
        // Everything that could still fail before the record is written is settled first, so a spent code always made a hive.
        if (!this.parts.Hives.HasTenant(request.Tenant))
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.Mismatch)
        }
        const id = existing?.id ?? this.parts.Ids.Next()
        // A placement's code enrols only the hive its placement is for (checked before the code is spent): the placement
        // still stands, links no other hive, and the console answers at the placement's relayed hive subdomain.
        const placementId = (await this.parts.Codes.Peek(request.EnrolmentCode))?.placementId
        if (placementId !== undefined && this.parts.Placements?.Accepts(placementId, id, request.ConsoleAddress) !== true)
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.Mismatch)
        }
        const code = await this.Redeem(request, level)
        if (code.placementId !== placementId)
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.Mismatch)
        }
        const input: EnrolledHiveInput = {
            id,
            tenantId: request.Tenant,
            level,
            publicKey: request.PublicKey.ToJson(),
            keyId: request.PublicKey.KeyId,
            engineVersion: request.EngineVersion,
            consoleAddress: { Option: request.ConsoleAddress.Option, Host: request.ConsoleAddress.HostName, IngressAddress: request.ConsoleAddress.IngressAddress },
            enrolledBy: code.issuedBy,
        }
        // The recovery keeps the hive (its id and key) and records this enrolment's details and who asked.
        const hive = existing === undefined ? await this.parts.Hives.EnrolHive(input) : await this.parts.Hives.ReEnrolHive(existing.id, input)
        if (code.placementId !== undefined)
        {
            await this.parts.Placements?.HiveEnrolled(code.placementId, hive.id)
        }
        const response = HiveEnrolmentResponse.Create({
            HiveId: hive.id, Tenant: request.Tenant, Level: request.Level, TrustRoot: this.parts.TrustRoot, ChannelUrl: this.parts.ChannelUrl, RequestNonce: message.Envelope.Nonce,
        })
        return new AgentAnswer(MessageKind.HiveEnrolmentResponse, response)
    }

    /** Recorded for this tenant and level, never reported and not left: the answer was lost before the agent kept it. */
    private IsUnconfirmed(hive: PlatformHiveRecord, tenant: string, level: CustomerHiveLevel): boolean
    {
        return hive.tenantId === tenant && PlatformHiveRecords.LevelOf(hive) === level && !PlatformHiveRecords.HasLeft(hive)
            && this.parts.Reports.LatestRecord(hive.id) === undefined
    }

    private async Redeem(request: HiveEnrolmentRequest, level: CustomerHiveLevel): Promise<EnrolmentCodeRecord>
    {
        try
        {
            return await this.parts.Codes.Redeem(request.EnrolmentCode, { TenantId: request.Tenant, Level: level, AgentKind: EnrolmentAgentKind.Hive, KeyId: request.PublicKey.KeyId })
        }
        catch (error)
        {
            if (error instanceof EnrolmentCodeRefusedError)
            {
                throw new AgentExchangeRefusedError(HiveEnrolmentHandler.InvalidCodeReasons.has(error.Reason) ? AgentExchangeRefusal.InvalidCode : AgentExchangeRefusal.Mismatch)
            }
            throw error
        }
    }

    /** The customer API's level of the same wire value (the two enums share their values). */
    public static CustomerLevelOf(level: HiveLevel): CustomerHiveLevel
    {
        return level as string as CustomerHiveLevel
    }
}
