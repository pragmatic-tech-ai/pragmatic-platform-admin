import { ConsoleAdvertRegistry, type IConsoleAdvertLookup } from './console-advert-registry.js'
import { EmailDomainPolicy, type HiveRecord, type TenantRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { HiveConsoleSpecs } from './hive-console-spec.js'
import type { DomainStanding } from './console-domain-approvals.js'

/** Each tenant's approvals, revokes and verifications (ConsoleDomainApprovals). */
export interface IDomainStandingSource
{
    StandingOf(tenantId: string): DomainStanding
}

/** The directory reads DomainClaims needs: every tenant, and each tenant's hives. */
export interface IDomainClaimDirectory
{
    ListTenants(): readonly TenantRecord[]
    ListHives(tenantId: string): readonly HiveRecord[]
}

/**
 * Which tenants claim which email domains, read once from the directory and the adverts. The one claim rule: an in-hive tenant
 * (one of its hives is set to run the console) claims its usable advert's domains (ConsoleAdvertRegistry.UsableFor), approved or
 * not, and none without a usable advert; any other tenant claims its record's domains. Domains are normalised. A claimed domain is
 * contested for a tenant when another tenant claims it with standing (an operator approval or a passed TXT verification, not
 * revoked); a contested verified domain does not take effect on its own. A bare, unproven claim contests nothing, so a tenant
 * cannot squat a domain its owner proves (D4: customers start claims themselves). Without a standing source (Collect's third
 * argument) every other claim contests, the strict reading.
 */
export class DomainClaims
{
    private static readonly None: readonly string[] = []

    private constructor(private readonly claims: ReadonlyMap<string, readonly string[]>, private readonly standings: IDomainStandingSource | undefined)
    {
    }

    /** Reads every tenant's claim now; build a fresh one per public call so all its answers agree. */
    public static Collect(directory: IDomainClaimDirectory, adverts: IConsoleAdvertLookup | undefined, standings?: IDomainStandingSource): DomainClaims
    {
        const claims = new Map<string, readonly string[]>()
        for (const tenant of directory.ListTenants())
        {
            claims.set(tenant.id, DomainClaims.ClaimOf(tenant, directory.ListHives(tenant.id), adverts))
        }
        return new DomainClaims(claims, standings)
    }

    /** The tenant's claimed domains, normalised, deduped and sorted; none for an unknown tenant. */
    public ClaimedBy(tenantId: string): readonly string[]
    {
        return [...(this.claims.get(tenantId) ?? DomainClaims.None)]
    }

    /** Sorted ids of the tenants other than `tenantId` that claim `domain` (normalised). */
    public OthersClaiming(tenantId: string, domain: string): string[]
    {
        const normalised = EmailDomainPolicy.Normalise(domain)
        return [...this.claims].filter(([id, claimed]) => id !== tenantId && claimed.includes(normalised)).map(([id]) => id).sort()
    }

    /** Sorted ids of the other tenants whose claim of `domain` contests it: with standing (approved or verified, not
     *  revoked), or every other claimant without a standing source. */
    public Contesting(tenantId: string, domain: string): string[]
    {
        const normalised = EmailDomainPolicy.Normalise(domain)
        return this.OthersClaiming(tenantId, normalised).filter(other => this.HasStanding(other, normalised))
    }

    /** The tenant's claimed domains that another tenant contests. */
    public ContestedFor(tenantId: string): ReadonlySet<string>
    {
        return new Set(this.ClaimedBy(tenantId).filter(d => this.Contesting(tenantId, d).length > 0))
    }

    private HasStanding(tenantId: string, domain: string): boolean
    {
        if (this.standings === undefined)
        {
            return true
        }
        const standing = this.standings.StandingOf(tenantId)
        return !standing.revoked.includes(domain) && (standing.approved.includes(domain) || standing.verified.includes(domain))
    }

    private static ClaimOf(tenant: TenantRecord, hives: readonly HiveRecord[], adverts: IConsoleAdvertLookup | undefined): readonly string[]
    {
        if (HiveConsoleSpecs.ConsoleHiveOf(hives) === undefined)
        {
            return EmailDomainPolicy.Distinct(tenant.emailDomains ?? DomainClaims.None)
        }
        const advert = adverts === undefined ? undefined : ConsoleAdvertRegistry.UsableFor(adverts, tenant.id, hives)
        return EmailDomainPolicy.Distinct(advert?.emailDomains ?? DomainClaims.None)
    }
}
