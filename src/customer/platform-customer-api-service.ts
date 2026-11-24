import { EntitledOperation } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { CentralLoginSubject, EntitlementStatement } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CustomerApiError, CustomerApiGate, CustomerErrorCode, EnrolmentStart, HiveLevel, TenantView } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import type { CreateTenantRequest, DomainVerification, DomainVerificationRequest, HiveView, ICustomerApiService, LeaveHiveRequest, ListHivesRequest, ListTenantsRequest, StartEnrolmentRequest } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { DomainNotClaimedError, DomainVerificationUnavailableError, DomainVerifyThrottledError, EmailDomainsNotEditableError, InvalidEmailDomainError, InvalidRecordIdError, type TenantRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { IClientStatements } from '../entitlements/client-statements.js'
import { RecordExistsError, UnknownClientError, UnknownTenantError, type PlatformDirectory } from '../platform-directory.js'
import { DomainTakenError, type PlatformEmailDomains } from '../platform-email-domains.js'
import { ClientLockTimeoutError, type ClientLock } from './client-lock.js'
import type { ClientUsage } from './client-usage.js'
import { HiveViews } from './hive-views.js'
import { EngineInstallCommand, InvalidInstallReleaseError, InvalidInstallTenantError } from '../enrolment/engine-install-command.js'
import { EnrolmentAgentKind } from '../enrolment/enrolment-code-record.js'
import type { EnrolmentCodeIssuer } from '../enrolment/enrolment-code-issuer.js'
import type { PlacementRegistry } from '../placement/placement-registry.js'
import type { HiveObservationRecord } from '../hive-observation-record.js'
import { PlatformHiveRecords, type PlatformHiveRecord } from '../platform-records.js'

/** The platform release a tenant's install command names (PlatformDeploymentRegistry.InstallReleaseFor). */
export interface IInstallReleases
{
    InstallReleaseFor(tenantId: string): string | undefined
}

/** A hive's agent registration (PlatformDeploymentRegistry): leaving revokes it, so a forgotten agent stops dialling home. */
export interface IHiveRegistrations
{
    DeregisterHive(hiveId: string): Promise<void>
}

/** A hive's last report (HiveObservationRegistry). */
export interface IHiveReports
{
    LatestRecord(hiveId: string): HiveObservationRecord | undefined
}

/** The console adverts (ConsoleAdvertRegistry): leaving a hive forgets its advert, so its domain claims stop counting. */
export interface IHiveAdverts
{
    ForgetHive(hiveId: string): Promise<void>
}

/** The operator activity log (the console's AuditTrail): what operators must follow up is recorded there. */
export interface IOperatorActivity
{
    Record(actor: string, action: string, target: string, status: number, note?: string): Promise<void>
}

/** What the customer API service works over. */
export interface CustomerApiServiceParts
{
    Statements: IClientStatements
    Directory: PlatformDirectory
    Domains: PlatformEmailDomains
    Usage: ClientUsage
    /** Shared with the operator side, so an operator's create and a customer's are decided one at a time per client. */
    Lock: ClientLock
    Codes: EnrolmentCodeIssuer
    Placements: PlacementRegistry
    Releases: IInstallReleases
    Registrations: IHiveRegistrations
    Reports: IHiveReports
    Adverts: IHiveAdverts
    /** Without it nothing is recorded for operators (tests). */
    Activity?: IOperatorActivity
    Now?: () => Date
}

/**
 * The platform admin console's customer API over its platform directory. Every operation first checks the caller
 * against the client's newest entitlement statement (CustomerApiGate: one of its customer admins; a gated operation
 * allowed at the current usage). A gated operation's decision and its write run in one ClientLock section, so usage is
 * counted at the moment of the decision. A tenant the client does not own reads as unknown, like one that does not
 * exist. Reads, checks and leaving are never gated (a suspended client still lists and leaves).
 */
export class PlatformCustomerApiService implements ICustomerApiService
{
    /** Tenant ids a customer may not take: names of the platform's own services and hosts, and words that would read as
     *  ours in a host name. Operators are not bound by it. */
    public static readonly ReservedTenantIds: ReadonlySet<string> = new Set(['admin', 'agent', 'api', 'auth', 'cabinet', 'console', 'docs', 'help', 'hooks', 'idp',
        'ledger', 'login', 'mail', 'mesh', 'platform', 'pragmatic', 'root', 'staff', 'status', 'support', 'system', 'test', 'www'])
    public static readonly LeaveAction = 'POST'
    public static readonly LeaveTarget = '/internal/customer/v1/leave-hive'
    private static readonly HostedLeftPrefix = 'customer left hosted hive '
    private static readonly HostedLeftSuffix = ': cluster still placed, remove it (C5.1 automates this)'
    private static readonly StatusOk = 200

    public constructor(protected readonly parts: CustomerApiServiceParts)
    {
    }

    public CreateTenant(customer: CentralLoginSubject, request: CreateTenantRequest): Promise<TenantView>
    {
        return this.Locked(request.ClientId, async () =>
        {
            await this.RequireEntitled(customer, request.ClientId, EntitledOperation.CreateTenant)
            if (PlatformCustomerApiService.ReservedTenantIds.has(request.TenantId))
            {
                throw new CustomerApiError(CustomerErrorCode.InvalidRequest)
            }
            try
            {
                const record = await this.parts.Directory.CreateTenant({ id: request.TenantId, clientId: request.ClientId, displayName: request.DisplayName, createdBy: customer.Key })
                return PlatformCustomerApiService.TenantViewOf(record)
            }
            catch (err)
            {
                throw PlatformCustomerApiService.Refusal(err)
            }
        })
    }

    public async ListTenants(customer: CentralLoginSubject, request: ListTenantsRequest): Promise<readonly TenantView[]>
    {
        await this.RequireAdmin(customer, request.ClientId)
        return this.parts.Directory.ListTenants(request.ClientId).map(tenant => PlatformCustomerApiService.TenantViewOf(tenant))
    }

    public StartDomainVerification(customer: CentralLoginSubject, request: DomainVerificationRequest): Promise<DomainVerification>
    {
        return this.Locked(request.ClientId, async () =>
        {
            const statement = await this.RequireAdmin(customer, request.ClientId)
            this.TenantOf(request.ClientId, request.TenantId)
            // Restarting a domain the tenant already holds adds nothing, so it does not count against the limit; a suspended
            // client is refused either way.
            const held = this.parts.Domains.Holds(request.TenantId, request.Domain) ? 1 : 0
            const usage = await this.parts.Usage.Of(request.ClientId, EntitledOperation.VerifyEmailDomain) - held
            CustomerApiGate.RequireEntitled(request.ClientId, statement, customer, EntitledOperation.VerifyEmailDomain, usage)
            try
            {
                return await this.parts.Domains.StartForCustomer(request.TenantId, request.Domain)
            }
            catch (err)
            {
                throw PlatformCustomerApiService.Refusal(err)
            }
        })
    }

    public async CheckDomainVerification(customer: CentralLoginSubject, request: DomainVerificationRequest): Promise<DomainVerification>
    {
        await this.RequireAdmin(customer, request.ClientId)
        this.TenantOf(request.ClientId, request.TenantId)
        try
        {
            return await this.parts.Domains.CheckForCustomer(request.TenantId, request.Domain)
        }
        catch (err)
        {
            throw PlatformCustomerApiService.Refusal(err)
        }
    }

    /**
     * Standalone: the install command only (admin of the client; nothing recorded or counted). Enrolled and Delegated:
     * gated `enrol-hive`; the install command plus a one-time enrolment code for an engine hive. Hosted: gated
     * `enrol-hive`; a requested placement. The command names the newest release the tenant admits (none: unavailable).
     */
    public async StartEnrolment(customer: CentralLoginSubject, request: StartEnrolmentRequest): Promise<EnrolmentStart>
    {
        if (request.Level === HiveLevel.Standalone)
        {
            await this.RequireAdmin(customer, request.ClientId)
            this.TenantOf(request.ClientId, request.TenantId)
            return EnrolmentStart.Standalone(this.InstallCommandFor(request.TenantId, request.Level))
        }
        return await this.Locked(request.ClientId, async () =>
        {
            const statement = await this.RequireAdmin(customer, request.ClientId)
            this.TenantOf(request.ClientId, request.TenantId)
            CustomerApiGate.RequireEntitled(request.ClientId, statement, customer, EntitledOperation.EnrolHive, await this.parts.Usage.Of(request.ClientId, EntitledOperation.EnrolHive))
            if (request.Level === HiveLevel.Hosted)
            {
                return EnrolmentStart.Hosted((await this.parts.Placements.Request(request.ClientId, request.TenantId, customer.Key)).id)
            }
            const command = this.InstallCommandFor(request.TenantId, request.Level)
            const code = await this.parts.Codes.Issue({ ClientId: request.ClientId, TenantId: request.TenantId, Level: request.Level, AgentKind: EnrolmentAgentKind.Hive, IssuedBy: customer.Key })
            return EnrolmentStart.Connected(request.Level as HiveLevel.Enrolled | HiveLevel.Delegated, command, code.Code, code.ExpiresAt)
        })
    }

    /** The client's hives (of one tenant or all) and its open placements (pending). */
    public async ListHives(customer: CentralLoginSubject, request: ListHivesRequest): Promise<readonly HiveView[]>
    {
        await this.RequireAdmin(customer, request.ClientId)
        const tenants = request.TenantId === null ? this.parts.Directory.ListTenants(request.ClientId) : [this.TenantOf(request.ClientId, request.TenantId)]
        const now = this.Now()
        const hives = tenants.flatMap(tenant => this.parts.Directory.ListHives(tenant.id) as readonly PlatformHiveRecord[])
            .map(hive => HiveViews.Of(hive, this.parts.Reports.LatestRecord(hive.id), now))
        const placements = this.parts.Placements.OpenFor(request.ClientId, request.TenantId ?? undefined).map(placement => HiveViews.OfPlacement(placement))
        return [...hives, ...placements]
    }

    /**
     * The customer uninstalled: the hive is marked gone first (kept, never deleted; from then on the deployment registry
     * refuses to register it again, so an install or registration racing the leave cannot bring its agent back), then its
     * agent registration is revoked and its console advert forgotten (its domain claims released). Leaving a Hosted hive
     * records an operator activity entry: its cluster is still placed on our machines. An open placement of the client is
     * withdrawn (cancelled) instead. Never gated: a suspended client may leave. Leaving again answers the gone hive.
     */
    public async LeaveHive(customer: CentralLoginSubject, request: LeaveHiveRequest): Promise<HiveView>
    {
        await this.RequireAdmin(customer, request.ClientId)
        const placement = this.parts.Placements.OpenOf(request.ClientId, request.HiveId)
        if (placement !== undefined)
        {
            return HiveViews.OfPlacement(await this.parts.Placements.Cancel(placement.id))
        }
        const directory = this.parts.Directory
        const hive = directory.GetHive(request.HiveId) as PlatformHiveRecord | undefined
        const tenant = hive === undefined ? undefined : directory.GetTenant(hive.tenantId)
        if (hive === undefined || tenant === undefined || tenant.clientId !== request.ClientId)
        {
            throw new CustomerApiError(CustomerErrorCode.UnknownHive)
        }
        const leaving = !PlatformHiveRecords.HasLeft(hive)
        const left = await directory.MarkHiveLeft(hive.id)
        await this.parts.Registrations.DeregisterHive(hive.id)
        await this.parts.Adverts.ForgetHive(hive.id)
        if (leaving && PlatformHiveRecords.LevelOf(left) === HiveLevel.Hosted)
        {
            const S = PlatformCustomerApiService
            await this.parts.Activity?.Record(customer.Email, S.LeaveAction, S.LeaveTarget, S.StatusOk, S.HostedLeftPrefix + hive.id + S.HostedLeftSuffix)
        }
        return HiveViews.Of(left, this.parts.Reports.LatestRecord(hive.id), this.Now())
    }

    /** The statement, when the customer administers the client. */
    protected async RequireAdmin(customer: CentralLoginSubject, clientId: string): Promise<EntitlementStatement>
    {
        return CustomerApiGate.RequireAdmin(clientId, await this.parts.Statements.Current(clientId), customer)
    }

    /** RequireAdmin, then the entitlement's decision at the client's current usage; run inside the client's lock. */
    protected async RequireEntitled(customer: CentralLoginSubject, clientId: string, operation: EntitledOperation): Promise<EntitlementStatement>
    {
        const statement = await this.RequireAdmin(customer, clientId)
        return CustomerApiGate.RequireEntitled(clientId, statement, customer, operation, await this.parts.Usage.Of(clientId, operation))
    }

    private InstallCommandFor(tenantId: string, level: HiveLevel): string
    {
        const release = this.parts.Releases.InstallReleaseFor(tenantId)
        if (release === undefined)
        {
            throw new CustomerApiError(CustomerErrorCode.Unavailable)
        }
        try
        {
            return EngineInstallCommand.For(level, release, tenantId)
        }
        catch (err)
        {
            throw PlatformCustomerApiService.Refusal(err)
        }
    }

    /** The client's lock section; a section that could not start in time is `unavailable`. */
    private async Locked<T>(clientId: string, work: () => Promise<T>): Promise<T>
    {
        try
        {
            return await this.parts.Lock.Run(clientId, work)
        }
        catch (err)
        {
            throw PlatformCustomerApiService.Refusal(err)
        }
    }

    private Now(): Date
    {
        return this.parts.Now?.() ?? new Date()
    }

    /** The client's tenant; one that does not exist or belongs to another client is `unknown-tenant` alike. */
    protected TenantOf(clientId: string, tenantId: string): TenantRecord
    {
        const tenant = this.parts.Directory.GetTenant(tenantId)
        if (tenant === undefined || tenant.clientId !== clientId)
        {
            throw new CustomerApiError(CustomerErrorCode.UnknownTenant)
        }
        return tenant
    }

    private static TenantViewOf(tenant: TenantRecord): TenantView
    {
        return new TenantView(tenant.id, tenant.clientId, tenant.displayName, new Date(tenant.createdAt))
    }

    /** The customer API's refusal for a directory or domain error; anything else passes through (a 500). */
    protected static Refusal(err: unknown): unknown
    {
        if (err instanceof CustomerApiError)
        {
            return err
        }
        if (err instanceof RecordExistsError)
        {
            return new CustomerApiError(CustomerErrorCode.TenantTaken)
        }
        if (err instanceof InvalidRecordIdError || err instanceof EmailDomainsNotEditableError || err instanceof DomainNotClaimedError)
        {
            return new CustomerApiError(CustomerErrorCode.InvalidRequest)
        }
        if (err instanceof InvalidEmailDomainError)
        {
            return new CustomerApiError(CustomerErrorCode.InvalidDomain)
        }
        if (err instanceof DomainTakenError)
        {
            return new CustomerApiError(CustomerErrorCode.DomainTaken)
        }
        if (err instanceof UnknownTenantError)
        {
            return new CustomerApiError(CustomerErrorCode.UnknownTenant)
        }
        if (err instanceof DomainVerifyThrottledError)
        {
            return new CustomerApiError(CustomerErrorCode.RateLimited)
        }
        if (err instanceof UnknownClientError || err instanceof DomainVerificationUnavailableError || err instanceof InvalidInstallReleaseError || err instanceof InvalidInstallTenantError || err instanceof ClientLockTimeoutError)
        {
            return new CustomerApiError(CustomerErrorCode.Unavailable)
        }
        return err
    }
}
