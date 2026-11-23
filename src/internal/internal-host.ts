import { AgentChannelOperation, InternalApiRoutes } from '@pragmatic-tech-ai/pragmatic-platform-link'
import type { AgentChannelRequest, IAgentChannelBackend, IDesktopDiscoveryBackend } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { AppHost, AppHostConfig, BadRequestProblem, HttpMethod, InternalApiGuard, JsonFields, ProblemMapper, RouteAuth, RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import type { RequestContext } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CustomerCallAuthenticator, EntitlementReceiver } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { ICentralLoginVerifier, IEntitlementSink } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CustomerApiRoutes } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import type { ICustomerApiService } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import type { InternalSettings } from './internal-settings.js'

/** What the internal listener answers with. The entitlements and customer parts are optional: a link is mounted only
 *  when its setting is on and its part is given. */
export interface InternalHostParts
{
    Agent: IAgentChannelBackend
    Discovery: IDesktopDiscoveryBackend
    Sink?: IEntitlementSink
    Customer?: ICustomerApiService
    Verifier?: ICentralLoginVerifier
}

/** The links an internal listener carries (for its start log). */
export enum InternalLink
{
    InternalApi = 'internal-api',
    Entitlements = 'entitlements',
    CustomerApi = 'customer-api',
}

/**
 * The console's internal listener (loopback, or the mesh; never public) on AppHost, carrying one link per caller, each
 * with its own bearer: the edge's internal API (agent channel and desktop discovery, carried verbatim: the reply's own
 * Status is inside the 200 body), the ledger's entitlement statements (EntitlementReceiver) and the customer API the
 * edge relays (CustomerApiRoutes, which verifies the customer's central-login token itself). Without a link's setting
 * its routes are absent (404). Every credential is read when the host is composed, so a bad secret file refuses the
 * start, naming its setting.
 */
export class InternalHost
{
    /** The edge forwards hive bodies of up to 1 MiB raw inside a JSON string; escaping can grow each byte to a
     *  six-character escape, so the agent route's limit covers the worst case plus the envelope. */
    public static readonly AgentBodyLimit = 6 * 1048576 + 65536
    public static readonly DiscoverBodyLimit = 4096
    private static readonly ApiPrefix = '/internal/'
    private static readonly StatusOk = 200
    private static readonly MaxEmailLength = 254
    private static readonly EmailField = 'email'
    private static readonly OperationField = 'Operation'
    private static readonly HiveIdField = 'HiveId'
    private static readonly TokenField = 'Token'
    private static readonly BodyField = 'Body'
    private static readonly QueryField = 'Query'
    private static readonly BadAgentRequest = 'Not an agent-channel request'
    private static readonly BadDiscoverRequest = 'Body must be { email }'
    private static readonly OkBody = { ok: true }
    private static readonly LogPrefix = '[internal-api]'
    private static readonly FallbackErrorName = 'Error'
    private static readonly Operations: ReadonlySet<string> = new Set(Object.values(AgentChannelOperation))

    private readonly app: AppHost
    public readonly Links: readonly InternalLink[]

    public constructor(private readonly settings: InternalSettings, private readonly parts: InternalHostParts)
    {
        const routes = new RouteTable()
        const links: InternalLink[] = [InternalLink.InternalApi]
        this.MountInternalApi(routes, new InternalApiGuard(settings.InternalCredential()))
        const entitlements = settings.EntitlementsCredential()
        if (entitlements !== undefined && parts.Sink !== undefined)
        {
            new EntitlementReceiver(entitlements, parts.Sink).MountOn(routes)
            links.push(InternalLink.Entitlements)
        }
        const customer = settings.CustomerApiCredential()
        if (customer !== undefined && parts.Customer !== undefined && parts.Verifier !== undefined)
        {
            new CustomerApiRoutes(parts.Customer, new CustomerCallAuthenticator(customer, parts.Verifier)).MountOn(routes)
            links.push(InternalLink.CustomerApi)
        }
        this.Links = links
        const problems = new ProblemMapper(err => console.error(InternalHost.LogPrefix, err instanceof Error ? err.name : InternalHost.FallbackErrorName))
        this.app = new AppHost(new AppHostConfig({ ApiPrefix: InternalHost.ApiPrefix }), { Routes: routes, Problems: problems })
    }

    public Listen(): Promise<void>
    {
        return this.app.Listen(this.settings.Port, this.settings.Bind)
    }

    public Close(): Promise<void>
    {
        return this.app.Close()
    }

    public Address(): { address: string, port: number }
    {
        return this.app.Address()
    }

    private MountInternalApi(routes: RouteTable, guard: InternalApiGuard): void
    {
        const I = InternalHost
        routes.Add({
            Method: HttpMethod.Get,
            Pattern: InternalApiRoutes.Healthz,
            Auth: RouteAuth.Public,
            Handler: async (context: RequestContext) =>
            {
                context.WriteJson(I.StatusOk, I.OkBody)
            },
        })
        routes.Add({
            Method: HttpMethod.Post,
            Pattern: InternalApiRoutes.Agent,
            Auth: RouteAuth.Public,
            BodyLimit: I.AgentBodyLimit,
            Handler: async (context: RequestContext) =>
            {
                guard.Require(context)
                const request = I.AgentRequestOf(await context.ReadJson())
                context.WriteJson(I.StatusOk, await this.parts.Agent.Handle(request))
            },
        })
        routes.Add({
            Method: HttpMethod.Post,
            Pattern: InternalApiRoutes.Discover,
            Auth: RouteAuth.Public,
            BodyLimit: I.DiscoverBodyLimit,
            Handler: async (context: RequestContext) =>
            {
                guard.Require(context)
                const email = I.EmailOf(await context.ReadJson())
                context.WriteJson(I.StatusOk, await this.parts.Discovery.Discover(email))
            },
        })
    }

    /** The validated request; anything else is a 400. */
    private static AgentRequestOf(body: unknown): AgentChannelRequest
    {
        const I = InternalHost
        if (!JsonFields.IsObject(body))
        {
            throw new BadRequestProblem(I.BadAgentRequest)
        }
        const operation = body[I.OperationField]
        const hiveId = body[I.HiveIdField]
        const token = body[I.TokenField]
        const raw = body[I.BodyField]
        const query = body[I.QueryField]
        const queryOk = query === undefined || (JsonFields.IsObject(query) && Object.values(query).every(value => typeof value === 'string'))
        if (typeof operation !== 'string' || !I.Operations.has(operation) || typeof hiveId !== 'string' || hiveId.length === 0
            || typeof token !== 'string' || token.length === 0 || (raw !== undefined && typeof raw !== 'string') || !queryOk)
        {
            throw new BadRequestProblem(I.BadAgentRequest)
        }
        return { Operation: operation as AgentChannelOperation, HiveId: hiveId, Token: token, Body: raw as string | undefined, Query: query as Record<string, string> | undefined }
    }

    private static EmailOf(body: unknown): string
    {
        const email = JsonFields.IsObject(body) ? body[InternalHost.EmailField] : undefined
        if (typeof email !== 'string' || email.length === 0 || email.length > InternalHost.MaxEmailLength)
        {
            throw new BadRequestProblem(InternalHost.BadDiscoverRequest)
        }
        return email
    }
}
