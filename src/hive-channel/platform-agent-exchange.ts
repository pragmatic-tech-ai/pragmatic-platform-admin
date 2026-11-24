import {
    AgentExchangeRefusal, EnvelopeSigner, EnvelopeVerifier, MessageKind, ProtocolDecodeError, ProtocolVerificationError, VerificationFailure,
    type IAgentChannel, type IBodyDecoder, type IMessageBody, type SignedEnvelope, type SigningPublicKey, type VerifiedMessage,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'

/** A message the platform turns away, with the code it answers (never text from the message). */
export class AgentExchangeRefusedError extends Error
{
    private static readonly ErrorName = 'AgentExchangeRefusedError'
    private static readonly MessagePrefix = 'agent exchange refused: '

    public constructor(public readonly Code: AgentExchangeRefusal)
    {
        super(AgentExchangeRefusedError.MessagePrefix + Code)
        this.name = AgentExchangeRefusedError.ErrorName
    }

    /** The code for any error raised while taking a message: ours as they are, verification failures by kind,
     *  anything else `unavailable` (the caller logs its name only). */
    public static CodeOf(error: unknown): AgentExchangeRefusal
    {
        if (error instanceof AgentExchangeRefusedError)
        {
            return error.Code
        }
        if (error instanceof ProtocolDecodeError)
        {
            return AgentExchangeRefusal.Malformed
        }
        if (error instanceof ProtocolVerificationError)
        {
            switch (error.Failure)
            {
                case VerificationFailure.Malformed:
                    return AgentExchangeRefusal.Malformed
                case VerificationFailure.Replayed:
                    return AgentExchangeRefusal.Replayed
                default:
                    return AgentExchangeRefusal.NotVerified
            }
        }
        return AgentExchangeRefusal.Unavailable
    }
}

/** A handler's answer: a body the platform signs as `Kind` to the message's issuer, or null (acknowledged, 204). */
export class AgentAnswer
{
    public constructor(public readonly Kind: MessageKind, public readonly Body: IMessageBody)
    {
    }
}

/**
 * One kind of agent message the platform takes. `Decoder` decodes its body; `KeyOf` is set for a self-signed kind (an
 * enrolment request: the key is in the body); otherwise the issuer's registered key verifies it. `Handle` runs only
 * on a message that passed every check, nonce claimed.
 */
export interface IAgentMessageHandler<T = unknown>
{
    readonly Kind: MessageKind
    readonly Decoder: IBodyDecoder<T>
    KeyOf?(body: T): SigningPublicKey
    Handle(message: VerifiedMessage<T>): Promise<AgentAnswer | null>
}

/**
 * The platform's side of the agent channel (C3.3): verify (kind table, issuer key or self-signed key, audience,
 * signature, freshness, nonce claimed once in the ledger, body strictly decoded; a malformed body burns no nonce),
 * dispatch by MessageKind, sign the answer with the trust root to the message's issuer. Refusals are
 * AgentExchangeRefusedError codes.
 */
export class PlatformAgentExchange implements IAgentChannel
{
    private readonly handlers: ReadonlyMap<MessageKind, IAgentMessageHandler>

    public constructor(private readonly verifier: EnvelopeVerifier, private readonly signer: EnvelopeSigner, handlers: readonly IAgentMessageHandler[])
    {
        this.handlers = new Map(handlers.map(handler => [handler.Kind, handler]))
    }

    /** The kinds this exchange takes. */
    public get Kinds(): readonly MessageKind[]
    {
        return [...this.handlers.keys()]
    }

    public async Exchange(request: SignedEnvelope): Promise<SignedEnvelope | null>
    {
        const handler = this.handlers.get(request.Kind)
        if (handler === undefined)
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.UnsupportedKind)
        }
        const verified = handler.KeyOf === undefined
            ? await this.verifier.Verify(request, handler.Kind, handler.Decoder)
            : await this.verifier.VerifySelfSigned(request, handler.Kind, handler.Decoder, body => handler.KeyOf!(body))
        const answer = await handler.Handle(verified)
        return answer === null ? null : this.signer.Sign(answer.Kind, request.Issuer, answer.Body)
    }
}
