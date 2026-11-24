import { ParticipantRole, SigningPublicKey, type IKeyResolver, type Participant } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { PlatformHiveRecord } from '../platform-records.js'

/** Where the directory reads an enrolled hive's record. */
export interface IEnrolledHiveSource
{
    GetHive(id: string): PlatformHiveRecord | undefined
}

/** Where the directory reads an enrolled host's record (HostRegistry). */
export interface IEnrolledHostSource
{
    Get(id: string): { publicKey: string } | undefined
}

/**
 * The agent keys the platform verifies with (C3.3, C5.1): an enrolled hive's public key from its hive record, by hive
 * id, and an enrolled host's from its host record, by host id. A hive its customer left still resolves (its report is
 * then refused `hive-gone` by the handler, not as unverified); a hive installed by push has no key (it holds an agent
 * token on the v1 routes) and resolves to nothing, as does every host while the console takes no hosts.
 */
export class PlatformKeyDirectory implements IKeyResolver
{
    public constructor(private readonly hives: IEnrolledHiveSource, private readonly hosts?: IEnrolledHostSource)
    {
    }

    public Resolve(issuer: Participant): Promise<SigningPublicKey | undefined>
    {
        let key: string | undefined
        if (issuer.Role === ParticipantRole.Hive)
        {
            key = this.hives.GetHive(issuer.Id)?.publicKey
        }
        else if (issuer.Role === ParticipantRole.Host)
        {
            key = this.hosts?.Get(issuer.Id)?.publicKey
        }
        return Promise.resolve(key === undefined ? undefined : SigningPublicKey.Parse(key))
    }
}
