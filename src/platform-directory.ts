import type { ClientRegistry } from './client-registry.js'
import type { TenantRegistry } from './tenant-registry.js'
import type { HiveRegistry } from './hive-registry.js'
import { type EnvironmentRecord, HivePlacementError, RecordId, type TenantRecord, type HiveRecord, type ClusterSpec, type RegistrySpec, K8sManifestBuilder, EmailDomainPolicy, type HiveConsoleSpec, type ITenantRecordSource, HiveBackend, InfraMode } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { UnknownHiveError } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { HiveConsoleSpecs } from './hive-console-spec.js'
import { HiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import type { ClientRecord, EnrolledConsoleAddress, PlatformHiveRecord, PlatformTenantRecord } from './platform-records.js'

/** What an enrolling hive is recorded with (PlatformDirectory.EnrolHive). */
export interface EnrolledHiveInput
{
    id: string
    tenantId: string
    level: HiveLevel
    publicKey: string
    keyId: string
    engineVersion: string
    consoleAddress: EnrolledConsoleAddress
    enrolledBy: string
}

export interface IEnvironmentLookup
{
    List(): readonly EnvironmentRecord[]
}

// The kinds of platform record, as named in error messages.
export enum RecordKind
{
    Tenant = 'Tenant',
    Hive = 'Hive',
}

export class RecordExistsError extends Error
{
    private static readonly ErrorName = 'RecordExistsError'
    private static readonly Quote = '"'
    private static readonly MessageSuffix = ' already exists'

    public constructor(public readonly kind: RecordKind, id: string)
    {
        super(kind + ' ' + RecordExistsError.Quote + id + RecordExistsError.Quote + RecordExistsError.MessageSuffix)
        this.name = RecordExistsError.ErrorName
    }
}

export class TenantClientMismatchError extends Error
{
    private static readonly ErrorName = 'TenantClientMismatchError'
    private static readonly Quote = '"'
    private static readonly MessageMiddle = ' does not belong to client '

    public constructor(tenantId: string, clientId: string)
    {
        const Q = TenantClientMismatchError.Quote
        super(RecordKind.Tenant + ' ' + Q + tenantId + Q + TenantClientMismatchError.MessageMiddle + Q + clientId + Q)
        this.name = TenantClientMismatchError.ErrorName
    }
}

export class UnknownClientError extends Error
{
    private static readonly ErrorName = 'UnknownClientError'
    private static readonly MessagePrefix = 'Unknown client: '

    public constructor(id: string)
    {
        super(UnknownClientError.MessagePrefix + id)
        this.name = UnknownClientError.ErrorName
    }
}

export class UnknownTenantError extends Error
{
    private static readonly ErrorName = 'UnknownTenantError'
    private static readonly MessagePrefix = 'Unknown tenant: '

    public constructor(id: string)
    {
        super(UnknownTenantError.MessagePrefix + id)
        this.name = UnknownTenantError.ErrorName
    }
}

export class TenantHasHivesError extends Error
{
    private static readonly ErrorName = 'TenantHasHivesError'
    private static readonly MessagePrefix = 'Tenant still has hives: '

    public constructor(id: string)
    {
        super(TenantHasHivesError.MessagePrefix + id)
        this.name = TenantHasHivesError.ErrorName
    }
}

export class HiveHasEnvironmentsError extends Error
{
    private static readonly ErrorName = 'HiveHasEnvironmentsError'
    private static readonly MessagePrefix = 'Hive still has environments: '

    public constructor(id: string)
    {
        super(HiveHasEnvironmentsError.MessagePrefix + id)
        this.name = HiveHasEnvironmentsError.ErrorName
    }
}

/** The tenant already runs its console in another hive. */
export class InHiveConsoleTakenError extends Error
{
    private static readonly ErrorName = 'InHiveConsoleTakenError'

    public constructor(tenantId: string, hiveId: string)
    {
        super(`Tenant ${tenantId} already runs its console in hive ${hiveId}; a tenant has one console.`)
        this.name = InHiveConsoleTakenError.ErrorName
    }
}

export class PlatformDirectory implements ITenantRecordSource
{
    private defaultTrustRootRef: string | undefined

    public constructor(
        private readonly clients: ClientRegistry,
        private readonly tenants: TenantRegistry,
        private readonly hives: HiveRegistry,
        private readonly environments: IEnvironmentLookup,
        private readonly now: () => Date = () => new Date())
    {
    }

    public async Load(): Promise<void>
    {
        await this.clients.Load()
        await this.tenants.Load()
        await this.hives.Load()
        this.AssertOneConsolePerTenant()
    }

    private AssertOneConsolePerTenant(): void
    {
        const owners = new Map<string, string>()
        for (const hive of this.hives.List())
        {
            if (hive.console === undefined)
            {
                continue
            }
            const first = owners.get(hive.tenantId)
            if (first !== undefined)
            {
                throw new InHiveConsoleTakenError(hive.tenantId, first)
            }
            owners.set(hive.tenantId, hive.id)
        }
    }

    /**
     * Makes `ref` (the platform signing key) the trust root of every hive that has none, now and for hives created
     * later without one, so each hive can run the images the platform signs. A hive given its own trust root keeps it.
     * Returns the ids of the hives that were given the default.
     */
    public async UseDefaultTrustRoot(ref: string): Promise<string[]>
    {
        this.defaultTrustRootRef = ref
        const adopted: string[] = []
        for (const hive of this.hives.List())
        {
            if (hive.trustRootRef === undefined || hive.trustRootRef === '')
            {
                await this.hives.Put({ ...hive, trustRootRef: ref })
                adopted.push(hive.id)
            }
        }
        return adopted
    }

    public ListClients(): readonly ClientRecord[]
    {
        return this.clients.List()
    }

    public GetClient(id: string): ClientRecord | undefined
    {
        return this.clients.Get(id)
    }

    /**
     * Upserts a client record as the clients ledger's statements describe it (ClientProjection derives the same record);
     * the operators have no way to create, edit or delete a client: the ledger owns the client. Keeps an existing
     * record's creation time unless one is given.
     */
    public async RecordClient(input: { id: string; displayName: string; kind?: ClientRecord['kind']; createdAt?: string; entitlementVersion?: number }): Promise<ClientRecord>
    {
        RecordId.Validate(input.id)
        const record: ClientRecord = { id: input.id, displayName: input.displayName, createdAt: input.createdAt ?? this.clients.Get(input.id)?.createdAt ?? this.Stamp() }
        if (input.kind !== undefined)
        {
            record.kind = input.kind
        }
        if (input.entitlementVersion !== undefined)
        {
            record.entitlementVersion = input.entitlementVersion
        }
        await this.clients.Put(record)
        return record
    }

    public ListTenants(clientId?: string): readonly TenantRecord[]
    {
        const all = this.tenants.List()
        return clientId === undefined ? all : all.filter(t => t.clientId === clientId)
    }

    public GetTenant(id: string): TenantRecord | undefined
    {
        return this.tenants.Get(id)
    }

    /** Records a tenant; with an Owner (email and principal) when its sign-in runs in its hive rather than in a platform IdP. */
    public async CreateTenant(input: { id: string; clientId: string; displayName: string; ownerEmail?: string; ownerPrincipalId?: string; createdBy?: string }): Promise<PlatformTenantRecord>
    {
        this.AssertNew(RecordKind.Tenant, input.id, this.tenants.Get(input.id))
        if (this.clients.Get(input.clientId) === undefined)
        {
            throw new UnknownClientError(input.clientId)
        }
        const record: PlatformTenantRecord = { id: input.id, clientId: input.clientId, displayName: input.displayName, createdAt: this.Stamp() }
        if (input.createdBy !== undefined)
        {
            record.createdBy = input.createdBy
        }
        if (input.ownerEmail !== undefined && input.ownerPrincipalId !== undefined)
        {
            record.ownerEmail = input.ownerEmail
            record.ownerPrincipalId = input.ownerPrincipalId
        }
        await this.tenants.Put(record)
        return record
    }

    public async CreateProvisionedTenant(input: { id: string; clientId: string; displayName: string; ownerEmail: string; ownerPrincipalId: string; idpBaseUrl: string; idpCaRef?: string; idpAdminTokenRef?: string; createdBy?: string }): Promise<PlatformTenantRecord>
    {
        this.AssertCanCreateTenant(input.id, input.clientId)
        const record: PlatformTenantRecord = {
            id: input.id,
            clientId: input.clientId,
            displayName: input.displayName,
            createdAt: this.Stamp(),
            ownerEmail: input.ownerEmail,
            ownerPrincipalId: input.ownerPrincipalId,
            idpBaseUrl: input.idpBaseUrl,
            idpCaRef: input.idpCaRef,
            idpAdminTokenRef: input.idpAdminTokenRef
        }
        if (input.createdBy !== undefined)
        {
            record.createdBy = input.createdBy
        }
        await this.tenants.Put(record)
        return record
    }

    /** Read-only pre-flight: throws RecordExistsError for a duplicate id and UnknownClientError for a missing parent client. */
    public AssertCanCreateTenant(id: string, clientId: string): void
    {
        this.AssertNew(RecordKind.Tenant, id, this.tenants.Get(id))
        if (this.clients.Get(clientId) === undefined)
        {
            throw new UnknownClientError(clientId)
        }
    }

    /** Throws TenantHasHivesError while the tenant still owns hives; the host runs this before any teardown. */
    public AssertTenantDeletable(id: string): void
    {
        if (this.hives.List().some(h => h.tenantId === id))
        {
            throw new TenantHasHivesError(id)
        }
    }

    /** Parse via EmailDomainPolicy; an empty list removes the field. UnknownTenantError for an unknown id. */
    public async SetTenantEmailDomains(tenantId: string, domains: unknown): Promise<TenantRecord>
    {
        const tenant = this.tenants.Get(tenantId)
        if (tenant === undefined)
        {
            throw new UnknownTenantError(tenantId)
        }
        const parsed = EmailDomainPolicy.Parse(domains)
        const { emailDomains: _previous, ...rest } = tenant
        const updated: TenantRecord = parsed.length === 0 ? rest : { ...rest, emailDomains: parsed }
        await this.tenants.Put(updated)
        return updated
    }

    public async DeleteTenant(id: string): Promise<void>
    {
        this.AssertTenantDeletable(id)
        await this.tenants.Remove(id)
    }

    public ListHives(tenantId?: string): readonly HiveRecord[]
    {
        const all = this.hives.List()
        return tenantId === undefined ? all : all.filter(h => h.tenantId === tenantId)
    }

    public GetHive(id: string): HiveRecord | undefined
    {
        return this.hives.Get(id)
    }

    /** Records a hive at its management level: an operator-created hive is Hosted (the default), the level of every hive
     *  the platform manages fully; customers bring their own hives at the other levels through enrolment (C3.3). */
    public async CreateHive(input: { id: string; tenantId: string; displayName: string; cluster: ClusterSpec; registry: RegistrySpec; trustRootRef?: string; level?: HiveLevel }): Promise<PlatformHiveRecord>
    {
        // The id becomes Kubernetes names and the pragmatic/hive label value: it must be a valid one.
        K8sManifestBuilder.AssertValidHiveId(input.id)
        this.AssertNew(RecordKind.Hive, input.id, this.hives.Get(input.id))
        if (this.tenants.Get(input.tenantId) === undefined)
        {
            throw new UnknownTenantError(input.tenantId)
        }
        const record: PlatformHiveRecord = {
            id: input.id,
            tenantId: input.tenantId,
            displayName: input.displayName,
            cluster: input.cluster,
            registry: input.registry,
            trustRootRef: input.trustRootRef === undefined || input.trustRootRef === '' ? this.defaultTrustRootRef : input.trustRootRef,
            createdAt: this.Stamp(),
            level: input.level ?? HiveLevel.Hosted,
        }
        await this.hives.Put(record)
        return record
    }

    /**
     * Records a hive that enrolled itself (C3.3): by its public key alone (no agent token, no cluster credential), at the
     * level its one-time code was issued for, with the console address and engine version it reported. The cluster is
     * the customer's (attached, private: the platform never reaches into it), the registry theirs.
     */
    public async EnrolHive(input: EnrolledHiveInput): Promise<PlatformHiveRecord>
    {
        K8sManifestBuilder.AssertValidHiveId(input.id)
        this.AssertNew(RecordKind.Hive, input.id, this.hives.Get(input.id))
        if (this.tenants.Get(input.tenantId) === undefined)
        {
            throw new UnknownTenantError(input.tenantId)
        }
        const stamp = this.Stamp()
        const record: PlatformHiveRecord = {
            id: input.id,
            tenantId: input.tenantId,
            displayName: input.id,
            cluster: { backend: HiveBackend.Private, mode: InfraMode.Attach },
            registry: { mode: InfraMode.Attach },
            trustRootRef: this.defaultTrustRootRef,
            createdAt: stamp,
            level: input.level,
            publicKey: input.publicKey,
            keyId: input.keyId,
            engineVersion: input.engineVersion,
            consoleAddress: input.consoleAddress,
            enrolledAt: stamp,
            enrolledBy: input.enrolledBy,
        }
        await this.hives.Put(record)
        return record
    }

    public HasTenant(id: string): boolean
    {
        return this.tenants.Get(id) !== undefined
    }

    /**
     * Records a repeated enrolment of a hive that never confirmed the first (HiveEnrolmentHandler's lost-answer
     * recovery): the same id, key, tenant and level; the engine version, console address, time and admin of this one.
     */
    public async ReEnrolHive(id: string, input: EnrolledHiveInput): Promise<PlatformHiveRecord>
    {
        const hive = this.hives.Get(id) as PlatformHiveRecord | undefined
        if (hive === undefined)
        {
            throw new UnknownHiveError(id)
        }
        const updated: PlatformHiveRecord = { ...hive, engineVersion: input.engineVersion, consoleAddress: input.consoleAddress, enrolledAt: this.Stamp(), enrolledBy: input.enrolledBy }
        await this.hives.Put(updated)
        return updated
    }

    /** The hive enrolled with this key id, when one is (whether or not its customer left it). */
    public HiveByKeyId(keyId: string): PlatformHiveRecord | undefined
    {
        return (this.hives.List() as readonly PlatformHiveRecord[]).find(hive => hive.keyId === keyId)
    }

    /** Sets (or, with undefined, clears) where the hive serves its tenant's console; a tenant has one console across its hives. */
    public async SetHiveConsole(hiveId: string, console: HiveConsoleSpec | undefined): Promise<HiveRecord>
    {
        const hive = this.hives.Get(hiveId)
        if (hive === undefined)
        {
            throw new UnknownHiveError(hiveId)
        }
        if (console !== undefined)
        {
            HiveConsoleSpecs.Validate(console, hive.tenantId)
        }
        const other = this.hives.List().find(h => h.tenantId === hive.tenantId && h.id !== hiveId && h.console !== undefined)
        if (console !== undefined && other !== undefined)
        {
            throw new InHiveConsoleTakenError(hive.tenantId, other.id)
        }
        const { console: _previous, ...rest } = hive
        const updated: HiveRecord = console === undefined ? rest : { ...rest, console }
        await this.hives.Put(updated)
        return updated
    }

    /**
     * Marks the hive left by its customer (never deletes it: the record stays for the operators) and releases where it
     * served its tenant's console, so its domain claims (the console's advert) stop counting. Leaving twice keeps the
     * first time. UnknownHiveError for an unknown id.
     */
    public async MarkHiveLeft(hiveId: string): Promise<PlatformHiveRecord>
    {
        const hive = this.hives.Get(hiveId) as PlatformHiveRecord | undefined
        if (hive === undefined)
        {
            throw new UnknownHiveError(hiveId)
        }
        if (hive.leftAt !== undefined)
        {
            return hive
        }
        const { console: _released, ...rest } = hive
        const updated: PlatformHiveRecord = { ...rest, leftAt: this.Stamp() }
        await this.hives.Put(updated)
        return updated
    }

    public async DeleteHive(id: string): Promise<void>
    {
        this.AssertHiveDeletable(id)
        await this.hives.Remove(id)
    }

    /** Throws HiveHasEnvironmentsError while any environment is still placed on the hive. */
    public AssertHiveDeletable(id: string): void
    {
        if (this.environments.List().some(e => e.hiveId === id))
        {
            throw new HiveHasEnvironmentsError(id)
        }
    }

    public ValidateHivePlacement(tenantId: string, hiveId: string): void
    {
        const hive = this.hives.Get(hiveId)
        HivePlacementError.Assert(hive, tenantId, hiveId)
    }

    private AssertNew(kind: RecordKind, id: string, existing: unknown): void
    {
        RecordId.Validate(id)
        if (existing !== undefined)
        {
            throw new RecordExistsError(kind, id)
        }
    }

    private Stamp(): string
    {
        return this.now().toISOString()
    }
}
