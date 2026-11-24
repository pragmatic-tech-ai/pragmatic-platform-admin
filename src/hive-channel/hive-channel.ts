import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import type { IKeyStore } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { EnvelopeSigner, EnvelopeVerifier, Participant, ProtocolNames, SigningKeyPair, SystemProtocolClock, type IProtocolClock } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { HostChannel } from '../hosts/host-channel.js'
import { HiveEnrolmentHandler, type IEnrolledHives, type IEnrolmentCodes, type IHiveReportHistory } from './hive-enrolment-handler.js'
import { HiveIdAllocator } from './hive-id-allocator.js'
import { HiveReportHandler, type IHiveReportSink } from './hive-report-handler.js'
import { PlatformAgentExchange } from './platform-agent-exchange.js'
import { PlatformKeyDirectory } from './platform-key-directory.js'
import { SqlNonceLedger } from './sql-nonce-ledger.js'

/** What the signed agent exchange is composed from. */
export interface HiveChannelParts
{
    Session: ISqlSession
    Hives: IEnrolledHives
    Codes: IEnrolmentCodes
    Observations: IHiveReportSink & IHiveReportHistory
    Keys: IKeyStore
    /** The platform signing key's ref: its public half is the trust root every enrolled hive adopts. */
    KeyRef: string
    /** PRAGMATIC_AGENT_CHANNEL_URL: where hives reach the platform's edge. */
    ChannelUrl: string | undefined
    Clock?: IProtocolClock
    /** Where the start warning goes when the exchange cannot be composed. */
    Warn?: (line: string) => void
    /** The host side (C5.1): host enrolment, reports, placement pulls and results, credential handovers. */
    Hosts?: HostChannel
}

/**
 * Composes the platform's side of the signed agent channel (C3.3): the Postgres nonce ledger, the key directory over
 * the hive records, the verifier and signer under the platform signing key (the trust root), and the enrolment and
 * report handlers, and the host side when given (C5.1: HostChannel). Without an https channel URL there is nothing to
 * tell an enrolling hive or host, so the exchange is not composed (undefined) and its route is absent.
 */
export class HiveChannel
{
    public static readonly NoChannelWarning = 'The signed agent exchange is off: PRAGMATIC_AGENT_CHANNEL_URL must be the https URL of the platform edge, so engines cannot enrol (POST /internal/v2/agent/exchange is absent).'

    public static async Compose(parts: HiveChannelParts): Promise<PlatformAgentExchange | undefined>
    {
        if (parts.ChannelUrl === undefined || !ProtocolNames.HttpsUrl.test(parts.ChannelUrl))
        {
            (parts.Warn ?? (line => console.warn(line)))(HiveChannel.NoChannelWarning)
            return undefined
        }
        const clock = parts.Clock ?? new SystemProtocolClock()
        const key = SigningKeyPair.FromPrivatePem(await parts.Keys.PrivateKey(parts.KeyRef))
        const nonces = await SqlNonceLedger.Open(parts.Session, clock)
        const verifier = new EnvelopeVerifier({ Self: Participant.Platform, Keys: new PlatformKeyDirectory(parts.Hives, parts.Hosts?.Registry), Nonces: nonces, Clock: clock })
        const signer = new EnvelopeSigner(key, Participant.Platform, clock)
        const ids = new HiveIdAllocator(id => parts.Hives.GetHive(id) !== undefined)
        const placements = parts.Hosts === undefined ? {} : { Placements: parts.Hosts.Link }
        return new PlatformAgentExchange(verifier, signer, [
            new HiveEnrolmentHandler({ Codes: parts.Codes, Hives: parts.Hives, Reports: parts.Observations, Ids: ids, TrustRoot: key.PublicKey, ChannelUrl: parts.ChannelUrl, ...placements }),
            new HiveReportHandler(parts.Hives, parts.Observations),
            ...(parts.Hosts?.Handlers(signer, key.PublicKey, parts.ChannelUrl) ?? []),
        ])
    }
}
