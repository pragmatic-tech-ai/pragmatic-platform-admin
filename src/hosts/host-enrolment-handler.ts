import {
    AgentExchangeRefusal, HostEnrolmentRequest, HostEnrolmentResponse, MessageKind,
    type IBodyDecoder, type SealingPublicKey, type SigningPublicKey, type VerifiedMessage,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { EnrolmentCodeIssuer, EnrolmentCodeRefusal, EnrolmentCodeRefusedError } from '../enrolment/enrolment-code-issuer.js'
import type { EnrolmentCodeRecord } from '../enrolment/enrolment-code-record.js'
import type { IEnrolmentCodes } from '../hive-channel/hive-enrolment-handler.js'
import { AgentAnswer, AgentExchangeRefusedError, type IAgentMessageHandler } from '../hive-channel/platform-agent-exchange.js'
import type { HostRecord } from './host-record.js'
import type { HostEnrolment } from './host-registry.js'

/** Where enrolled hosts are recorded (HostRegistry). */
export interface IEnrolledHosts
{
    ByKeyId(keyId: string): HostRecord | undefined
    Enrol(enrolment: HostEnrolment): Promise<HostRecord>
    ReEnrol(id: string, enrolment: HostEnrolment): Promise<HostRecord>
}

export interface HostEnrolmentHandlerParts
{
    Codes: IEnrolmentCodes
    Hosts: IEnrolledHosts
    TrustRoot: SigningPublicKey
    SealingKey: SealingPublicKey
    ChannelUrl: string
}

/**
 * A host agent's one enrolment (C5.1): a self-signed HostEnrolmentRequest (its nonce already claimed) redeems an
 * operator's host code (agent kind host: a hive code never enrols a host, nor a host code a hive), records the host by
 * its public key and answers its host id, the trust root, the platform's X25519 sealing key and the channel URL. A key
 * already registered to a host is refused `key-registered` before the code is touched, except the one recovery C3.3
 * ruled for hives: the host was recorded but never reported (its answer was lost before it stored it), where a new
 * valid host code answers that same host again. Enrolments are taken one at a time.
 */
export class HostEnrolmentHandler implements IAgentMessageHandler<HostEnrolmentRequest>
{
    public readonly Kind = MessageKind.HostEnrolmentRequest
    public readonly Decoder: IBodyDecoder<HostEnrolmentRequest> = HostEnrolmentRequest
    private static readonly InvalidCodeReasons: ReadonlySet<EnrolmentCodeRefusal> = new Set([EnrolmentCodeRefusal.Unknown, EnrolmentCodeRefusal.Used, EnrolmentCodeRefusal.Expired])
    private turn: Promise<unknown> = Promise.resolve()

    public constructor(private readonly parts: HostEnrolmentHandlerParts)
    {
    }

    public KeyOf(body: HostEnrolmentRequest): SigningPublicKey
    {
        return HostEnrolmentRequest.KeyOf(body)
    }

    public Handle(message: VerifiedMessage<HostEnrolmentRequest>): Promise<AgentAnswer>
    {
        const next = this.turn.then(() => this.Enrol(message))
        this.turn = next.catch(() => undefined)
        return next
    }

    private async Enrol(message: VerifiedMessage<HostEnrolmentRequest>): Promise<AgentAnswer>
    {
        const request = message.Body
        const existing = this.parts.Hosts.ByKeyId(request.PublicKey.KeyId)
        if (existing !== undefined && existing.lastReportAt !== undefined)
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.KeyRegistered)
        }
        const code = await this.Redeem(request.EnrolmentCode)
        const enrolment: HostEnrolment = {
            machine: request.MachineName,
            clusterKind: request.ClusterKind,
            meshAddress: request.MeshAddress,
            publicKey: request.PublicKey.ToJson(),
            keyId: request.PublicKey.KeyId,
            agentVersion: request.AgentVersion,
            sealingKeyId: this.parts.SealingKey.KeyId,
            enrolledBy: code.issuedBy,
        }
        const host = existing === undefined ? await this.parts.Hosts.Enrol(enrolment) : await this.parts.Hosts.ReEnrol(existing.id, enrolment)
        const response = HostEnrolmentResponse.Create({
            HostId: host.id, TrustRoot: this.parts.TrustRoot, SealingKey: this.parts.SealingKey, ChannelUrl: this.parts.ChannelUrl, RequestNonce: message.Envelope.Nonce,
        })
        return new AgentAnswer(MessageKind.HostEnrolmentResponse, response)
    }

    private async Redeem(code: string): Promise<EnrolmentCodeRecord>
    {
        try
        {
            return await this.parts.Codes.Redeem(code, EnrolmentCodeIssuer.HostExpectation())
        }
        catch (error)
        {
            if (error instanceof EnrolmentCodeRefusedError)
            {
                throw new AgentExchangeRefusedError(HostEnrolmentHandler.InvalidCodeReasons.has(error.Reason) ? AgentExchangeRefusal.InvalidCode : AgentExchangeRefusal.Mismatch)
            }
            throw error
        }
    }
}
