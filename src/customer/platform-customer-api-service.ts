import { EntitledOperation } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { CentralLoginSubject, EntitlementStatement } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CustomerApiError, CustomerApiGate, CustomerErrorCode, TenantView } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import type { CreateTenantRequest, DomainVerification, DomainVerificationRequest, EnrolmentStart, HiveView, ICustomerApiService, LeaveHiveRequest, ListHivesRequest, ListTenantsRequest, StartEnrolmentRequest } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { DomainNotClaimedError, DomainVerificationUnavailableError, DomainVerifyThrottledError, EmailDomainsNotEditableError, InvalidEmailDomainError, InvalidRecordIdError, type TenantRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { IClientStatements } from '../entitlements/client-statements.js'
import { RecordExistsError, UnknownClientError, UnknownTenantError, type PlatformDirectory } from '../platform-directory.js'
import { DomainTakenError, type PlatformEmailDomains } from '../platform-email-domains.js'
import type { ClientLock } from './client-lock.js'
import type { ClientUsage } from './client-usage.js'

/** What the customer API service works over. */
export interface CustomerApiServiceParts
{
    Statements: IClientStatements
    Directory: PlatformDirectory
    Domains: PlatformEmailDomains
    Usage: ClientUsage
    /** Shared with the operator side, so an operator's create and a customer's are decided one at a time per client. */
    Lock: ClientLock
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
    public constructor(protected readonly parts: CustomerApiServiceParts)
    {
    }

    public CreateTenant(customer: CentralLoginSubject, request: CreateTenantRequest): Promise<TenantView>
    {
        return this.parts.Lock.Run(request.ClientId, async () =>
        {
            await this.RequireEntitled(customer, request.ClientId, EntitledOperation.CreateTenant)
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
        return this.parts.Lock.Run(request.ClientId, async () =>
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

    public StartEnrolment(_customer: CentralLoginSubject, _request: StartEnrolmentRequest): Promise<EnrolmentStart>
    {
        return Promise.reject(new CustomerApiError(CustomerErrorCode.Unavailable))
    }

    public ListHives(_customer: CentralLoginSubject, _request: ListHivesRequest): Promise<readonly HiveView[]>
    {
        return Promise.reject(new CustomerApiError(CustomerErrorCode.Unavailable))
    }

    public LeaveHive(_customer: CentralLoginSubject, _request: LeaveHiveRequest): Promise<HiveView>
    {
        return Promise.reject(new CustomerApiError(CustomerErrorCode.Unavailable))
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
        if (err instanceof UnknownClientError || err instanceof DomainVerificationUnavailableError || err instanceof DomainVerifyThrottledError)
        {
            return new CustomerApiError(CustomerErrorCode.Unavailable)
        }
        return err
    }
}
