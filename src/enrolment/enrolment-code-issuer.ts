import { createHash, randomBytes } from 'node:crypto'
import type { HiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import type { IHiveReservations } from '../customer/client-usage.js'
import type { EnrolmentAgentKind, EnrolmentCodeRecord, EnrolmentCodeRegistry } from './enrolment-code-record.js'

/** Why a code did not redeem. */
export enum EnrolmentCodeRefusal
{
    Unknown = 'unknown',
    Used = 'used',
    Expired = 'expired',
    /** Issued for another tenant, level or agent kind (the code is not consumed). */
    Mismatch = 'mismatch',
}

export class EnrolmentCodeRefusedError extends Error
{
    private static readonly ErrorName = 'EnrolmentCodeRefusedError'
    private static readonly MessagePrefix = 'enrolment code refused: '

    public constructor(public readonly Reason: EnrolmentCodeRefusal)
    {
        super(EnrolmentCodeRefusedError.MessagePrefix + Reason)
        this.name = EnrolmentCodeRefusedError.ErrorName
    }
}

/** What a code is issued for. */
export interface EnrolmentCodeRequest
{
    ClientId: string
    TenantId: string
    Level: HiveLevel
    AgentKind: EnrolmentAgentKind
    /** The subject key of the customer admin asking. */
    IssuedBy: string
}

/** What a code must match when it is redeemed. */
export interface EnrolmentCodeExpectation
{
    TenantId: string
    Level: HiveLevel
    AgentKind: EnrolmentAgentKind
}

/**
 * Issues and redeems the one-time enrolment codes a signed-in customer admin gets at "start enrolment": the code is the
 * proof that the admin asked for this enrolment (the engine's console asks for it at "connect this hive to Pragmatic").
 * A code is `pe1-` plus 26 base32 characters (130 random bits), stored as its SHA-256 only, valid 30 minutes and
 * redeemed at most once, for the tenant, level and agent kind it was issued for. Until it expires or is redeemed it
 * reserves one of the client's hives (IHiveReservations).
 */
export class EnrolmentCodeIssuer implements IHiveReservations
{
    public static readonly Prefix = 'pe1-'
    public static readonly LifetimeMs = 30 * 60 * 1000
    public static readonly CodePattern = /^pe1-[A-Z2-7]{26}$/
    private static readonly Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    private static readonly RandomBytes = 17
    private static readonly CodeCharacters = 26
    private static readonly BitsPerCharacter = 5n
    private static readonly BitsPerByte = 8n
    private static readonly CharacterMask = 31n
    private static readonly HashAlgorithm = 'sha256'
    private static readonly HashEncoding = 'hex'
    /** Expired or redeemed records are kept a day (for the operators), then pruned when the next code is issued. */
    private static readonly RetainMs = 24 * 60 * 60 * 1000

    public constructor(private readonly codes: EnrolmentCodeRegistry, private readonly now: () => Date = () => new Date())
    {
    }

    public async Issue(request: EnrolmentCodeRequest): Promise<{ Code: string; ExpiresAt: Date }>
    {
        const now = this.now()
        await this.Prune(now)
        const code = EnrolmentCodeIssuer.NewCode()
        const expiresAt = new Date(now.getTime() + EnrolmentCodeIssuer.LifetimeMs)
        await this.codes.Put({
            id: EnrolmentCodeIssuer.HashOf(code),
            clientId: request.ClientId,
            tenantId: request.TenantId,
            level: request.Level,
            agentKind: request.AgentKind,
            issuedBy: request.IssuedBy,
            issuedAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
        })
        return { Code: code, ExpiresAt: expiresAt }
    }

    /**
     * Redeems a code once: the check and the marking happen before the first await, so two concurrent redeems of one code
     * cannot both pass (one process). Throws EnrolmentCodeRefusedError: unknown, used, expired or mismatch (a mismatch
     * does not consume the code).
     */
    public async Redeem(code: string, expect: EnrolmentCodeExpectation): Promise<EnrolmentCodeRecord>
    {
        const I = EnrolmentCodeIssuer
        const record = I.CodePattern.test(code) ? this.codes.Get(I.HashOf(code)) : undefined
        if (record === undefined)
        {
            throw new EnrolmentCodeRefusedError(EnrolmentCodeRefusal.Unknown)
        }
        if (record.redeemedAt !== undefined)
        {
            throw new EnrolmentCodeRefusedError(EnrolmentCodeRefusal.Used)
        }
        const now = this.now()
        if (Date.parse(record.expiresAt) <= now.getTime())
        {
            throw new EnrolmentCodeRefusedError(EnrolmentCodeRefusal.Expired)
        }
        if (record.tenantId !== expect.TenantId || record.level !== expect.Level || record.agentKind !== expect.AgentKind)
        {
            throw new EnrolmentCodeRefusedError(EnrolmentCodeRefusal.Mismatch)
        }
        const redeemed: EnrolmentCodeRecord = { ...record, redeemedAt: now.toISOString() }
        await this.codes.Put(redeemed)
        return redeemed
    }

    /** The client's unexpired, unredeemed codes. */
    public OutstandingFor(clientId: string, now: Date): number
    {
        return this.codes.List().filter(record => record.clientId === clientId && record.redeemedAt === undefined && Date.parse(record.expiresAt) > now.getTime()).length
    }

    private async Prune(now: Date): Promise<void>
    {
        const horizon = now.getTime() - EnrolmentCodeIssuer.RetainMs
        for (const record of this.codes.List())
        {
            if (Date.parse(record.redeemedAt ?? record.expiresAt) < horizon)
            {
                await this.codes.Remove(record.id)
            }
        }
    }

    private static NewCode(): string
    {
        const I = EnrolmentCodeIssuer
        let bits = 0n
        for (const byte of randomBytes(I.RandomBytes))
        {
            bits = (bits << I.BitsPerByte) | BigInt(byte)
        }
        const characters: string[] = []
        for (let i = 0; i < I.CodeCharacters; i++)
        {
            characters.push(I.Alphabet[Number(bits & I.CharacterMask)] as string)
            bits >>= I.BitsPerCharacter
        }
        return I.Prefix + characters.join('')
    }

    private static HashOf(code: string): string
    {
        return createHash(EnrolmentCodeIssuer.HashAlgorithm).update(code).digest(EnrolmentCodeIssuer.HashEncoding)
    }
}
