import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import type { IKeyStore } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { EnvelopeSigner, EnvelopeVerifier, Participant, ProtocolNames, SigningKeyPair, SystemProtocolClock, type IProtocolClock, type SigningPublicKey } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { HostChannel } from '../hosts/host-channel.js'
import { HiveEnrolmentHandler, type IEnrolledHives, type IEnrolmentCodes, type IHiveReportHistory } from './hive-enrolment-handler.js'
import { HiveIdAllocator } from './hive-id-allocator.js'
import { HiveReportHandler, type IHiveReportSink } from './hive-report-handler.js'
import { PlatformAgentExchange } from './platform-agent-exchange.js'
import { PlatformKeyDirectory } from './platform-key-directory.js'
import { SqlNonceLedger } from './sql-nonce-ledger.js'
import { HiveKeyRotationHandler, type IRotatingHives } from './hive-key-rotation-handler.js'
import type { IntentOutbox } from '../intents/intent-outbox.js'
import { IntentDecisionHandler } from '../intents/intent-decision-handler.js'
import { HiveIntentPulls, PullHandler, type IPullSource } from '../intents/pull-handler.js'
import type { IIntentSequences } from '../intents/sql-intent-sequences.js'
import { PreviousKeyGrace, type IPreviousKeyHives } from './previous-key-grace.js'
import { PreviousKeyGraceVerifier } from './platform-agent-exchange.js'

/** What the signed agent exchange is composed from. */
export interface HiveChannelParts
{
    Session: ISqlSession
    Hives: IEnrolledHives & IRotatingHives & IPreviousKeyHives
    /** The per-hive intent outbox (C3.4): pulls, decisions and report progress. */
    Intents: IntentOutbox
    /** The hives' intent numbers (SqlIntentSequences): a pull keeps the hive's cursor there. */
    Sequences: IIntentSequences
    /** Pull sources of other agent roles (C5.1: a host's placements), beside the hive's intents. */
    PullSources?: readonly IPullSource[]
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
 * report handlers, the intent pull, decision and hive key rotation handlers (C3.4), and the host side when given
 * (C5.1: HostChannel). Without an https channel URL there is nothing to tell an enrolling hive or host, so the exchange
 * is not composed (undefined) and its route is absent.
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
        const signer = await HiveChannel.SignerOf(parts.Keys, parts.KeyRef, clock)
        const nonces = await SqlNonceLedger.Open(parts.Session, clock)
        const verifier = new EnvelopeVerifier({ Self: Participant.Platform, Keys: new PlatformKeyDirectory(parts.Hives, parts.Hosts?.Registry), Nonces: nonces, Clock: clock })
        const ids = new HiveIdAllocator(id => parts.Hives.GetHive(id) !== undefined)
        const placements = parts.Hosts === undefined ? {} : { Placements: parts.Hosts.Link }
        const grace = new PreviousKeyGrace(parts.Hives, () => clock.Now())
        const graceVerifier = new PreviousKeyGraceVerifier(grace, new EnvelopeVerifier({ Self: Participant.Platform, Keys: grace, Nonces: nonces, Clock: clock }))
        return new PlatformAgentExchange(verifier, signer, [
            new HiveEnrolmentHandler({ Codes: parts.Codes, Hives: parts.Hives, Reports: parts.Observations, Ids: ids, TrustRoot: signer.PublicKey, ChannelUrl: parts.ChannelUrl, ...placements }),
            new HiveReportHandler(parts.Hives, parts.Observations, parts.Intents),
            new PullHandler([new HiveIntentPulls(parts.Hives, parts.Intents, parts.Sequences), ...(parts.PullSources ?? [])]),
            new IntentDecisionHandler(parts.Hives, parts.Intents),
            new HiveKeyRotationHandler(parts.Hives),
            ...(parts.Hosts?.Handlers(signer, signer.PublicKey, parts.ChannelUrl) ?? []),
        ], graceVerifier)
    }

    /** The platform's signer under the platform signing key (the trust root): answers and intents are signed by it. */
    public static async SignerOf(keys: IKeyStore, keyRef: string, clock: IProtocolClock = new SystemProtocolClock()): Promise<PlatformEnvelopeSigner>
    {
        return new PlatformEnvelopeSigner(SigningKeyPair.FromPrivatePem(await keys.PrivateKey(keyRef)), clock)
    }
}

/** The platform's envelope signer and the public half of its key (the trust root). */
export class PlatformEnvelopeSigner extends EnvelopeSigner
{
    public readonly PublicKey: SigningPublicKey

    public constructor(key: SigningKeyPair, clock: IProtocolClock)
    {
        super(key, Participant.Platform, clock)
        this.PublicKey = key.PublicKey
    }
}
