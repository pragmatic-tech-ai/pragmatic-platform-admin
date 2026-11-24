import { MessageKind, ParticipantRole, SigningPublicKey, type IKeyResolver, type Participant } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { PlatformHiveRecord } from '../platform-records.js'

/** Where a rotated hive's previous key is read and forgotten (PlatformDirectory). */
export interface IPreviousKeyHives
{
    GetHive(id: string): PlatformHiveRecord | undefined
    ConfirmHiveKey(id: string): Promise<void>
}

/**
 * The grace after a hive key rotation (C3.4): until the hive first uses its new key, and at most GraceMs after the
 * rotation, the key it replaced still verifies one kind of message only, a HiveKeyRotation (the hive asking again for
 * an acknowledgement it lost). Any message verified under the hive's current key ends the grace.
 */
export class PreviousKeyGrace implements IKeyResolver
{
    public static readonly GraceMs = 86_400_000
    public static readonly Kinds: readonly MessageKind[] = [MessageKind.HiveKeyRotation]

    public constructor(private readonly hives: IPreviousKeyHives, private readonly now: () => Date = () => new Date())
    {
    }

    /** Whether a message of `kind` may be verified under the previous key. */
    public Accepts(kind: MessageKind): boolean
    {
        return PreviousKeyGrace.Kinds.includes(kind)
    }

    /** The hive's previous key while its grace lasts; nothing otherwise. */
    public Resolve(issuer: Participant): Promise<SigningPublicKey | undefined>
    {
        if (issuer.Role !== ParticipantRole.Hive)
        {
            return Promise.resolve(undefined)
        }
        const hive = this.hives.GetHive(issuer.Id)
        if (hive?.previousPublicKey === undefined || hive.keyRotatedAt === undefined || Date.parse(hive.keyRotatedAt) + PreviousKeyGrace.GraceMs < this.now().getTime())
        {
            return Promise.resolve(undefined)
        }
        return Promise.resolve(SigningPublicKey.Parse(hive.previousPublicKey))
    }

    /** A message verified under the hive's current key: the previous key is forgotten. */
    public async CurrentKeyUsed(issuer: Participant): Promise<void>
    {
        if (issuer.Role === ParticipantRole.Hive && this.hives.GetHive(issuer.Id)?.previousKeyId !== undefined)
        {
            await this.hives.ConfirmHiveKey(issuer.Id)
        }
    }
}
