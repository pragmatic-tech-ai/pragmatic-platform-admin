import { BodyTooLargeError, HttpMethod, JsonApi, RouteAuth, type InternalApiGuard, type RequestContext, type RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import { AgentExchangeLink, AgentExchangeRefusal, SignedEnvelope, type IAgentChannel } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { InternalApiRoutes } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { AgentExchangeRefusedError } from './platform-agent-exchange.js'

/**
 * `POST /internal/v2/agent/exchange` on the console's internal listener (C3.3): the edge relays the agent's envelope
 * text verbatim under the internal bearer; the answer is 200 with the platform's envelope, 204, or a refusal
 * `{ error, code }` (AgentExchangeLink's status for the code). A body over 1 MiB or not an envelope is refused before
 * anything is verified, so it burns no nonce. Only an error's name is logged, never the message.
 */
export class AgentExchangeRoute
{
    private static readonly LogPrefix = '[agent-exchange]'
    private static readonly FallbackErrorName = 'Error'
    private static readonly ContentTypeHeader = 'content-type'

    public constructor(private readonly exchange: IAgentChannel, private readonly log: (line: string) => void = line => console.error(line))
    {
    }

    public MountOn(routes: RouteTable, guard: InternalApiGuard): void
    {
        routes.Add({
            Method: HttpMethod.Post,
            Pattern: InternalApiRoutes.AgentExchange,
            Auth: RouteAuth.Public,
            BodyLimit: AgentExchangeLink.BodyLimit,
            Handler: async (context: RequestContext) =>
            {
                guard.Require(context)
                await this.Answer(context)
            },
        })
    }

    private async Answer(context: RequestContext): Promise<void>
    {
        const A = AgentExchangeRoute
        let reply: SignedEnvelope | null
        try
        {
            const text = await JsonApi.ReadText(context.Request, AgentExchangeLink.BodyLimit)
            reply = await this.exchange.Exchange(SignedEnvelope.Decode(text, AgentExchangeLink.BodyLimit))
        }
        catch (error)
        {
            const code = error instanceof BodyTooLargeError ? AgentExchangeRefusal.TooLarge : AgentExchangeRefusedError.CodeOf(error)
            if (code === AgentExchangeRefusal.Unavailable)
            {
                this.log(A.LogPrefix + ' ' + (error instanceof Error ? error.name : A.FallbackErrorName))
            }
            context.WriteJson(AgentExchangeLink.StatusOf(code), AgentExchangeLink.RefusalBody(code))
            return
        }
        if (reply === null)
        {
            context.Response.writeHead(AgentExchangeLink.StatusAcknowledged).end()
            return
        }
        context.Response.writeHead(AgentExchangeLink.StatusAnswered, { [A.ContentTypeHeader]: AgentExchangeLink.ContentType }).end(reply.Encode())
    }
}
