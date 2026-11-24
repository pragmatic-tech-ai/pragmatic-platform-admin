import { ParticipantRole, SigningPublicKey, type IKeyResolver, type Participant } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { PlatformHiveRecord } from '../platform-records.js'

/** Where the directory reads an enrolled hive's record. */
export interface IEnrolledHiveSource
{
    GetHive(id: string): PlatformHiveRecord | undefined
}

/**
 * The agent keys the platform verifies with (C3.3): an enrolled hive's public key from its hive record, by hive id. A
 * hive its customer left still resolves (its report is then refused `hive-gone` by the handler, not as unverified); a
 * hive installed by push has no key (it holds an agent token on the v1 routes) and resolves to nothing, as do hosts
 * until host enrolment (C5.1) records their keys.
 */
export class PlatformKeyDirectory implements IKeyResolver
{
    public constructor(private readonly hives: IEnrolledHiveSource)
    {
    }

    public Resolve(issuer: Participant): Promise<SigningPublicKey | undefined>
    {
        if (issuer.Role !== ParticipantRole.Hive)
        {
            return Promise.resolve(undefined)
        }
        const key = this.hives.GetHive(issuer.Id)?.publicKey
        return Promise.resolve(key === undefined ? undefined : SigningPublicKey.Parse(key))
    }
}
