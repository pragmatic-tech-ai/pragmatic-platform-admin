import { isIP } from 'node:net'
import { InternalApiCredential, InternalApiSecretError } from '@pragmatic-tech-ai/pragmatic-app-host'
import { EntitlementsLink } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CustomerApiLink } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { InternalApiLink } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { CentralLoginSettings } from '../customer/central-login-settings.js'

/** A link's secret file could not be used: names the setting, never the file's content. */
export class InternalLinkSecretError extends Error
{
    private static readonly ErrorName = 'InternalLinkSecretError'
    private static readonly Separator = ': '

    public constructor(setting: string, cause: InternalApiSecretError)
    {
        super(setting + InternalLinkSecretError.Separator + cause.message, { cause })
        this.name = InternalLinkSecretError.ErrorName
    }
}

/**
 * The settings of the console's internal listener (loopback/mesh only) and of the links it carries: the edge's
 * internal API (always, PRAGMATIC_INTERNAL_API_SECRET_FILE), the ledger's entitlement statements (when
 * PRAGMATIC_ADMIN_ENTITLEMENTS_SECRET_FILE is set) and the customer API the edge relays (when
 * PRAGMATIC_ADMIN_CUSTOMER_API_SECRET_FILE is set, with the central login it verifies customers at). One secret file
 * per link; each is read when the listener is composed, and a refusal names its setting.
 *
 * The listener answers only the Host names it is reached by: the loopback names always, the bind address when it is
 * not a wildcard, and PRAGMATIC_ADMIN_INTERNAL_ALLOWED_HOSTS (comma-separated, e.g. a mesh name). A wildcard bind is
 * accepted on purpose: frontdoor's pod binds 0.0.0.0 inside its own network namespace, which publishes the port on the
 * host's loopback only; the listener is never reachable from a public interface by that construction, not by the bind.
 */
export class InternalSettings
{
    public static readonly PortEnvVar = 'PRAGMATIC_ADMIN_INTERNAL_PORT'
    public static readonly BindEnvVar = 'PRAGMATIC_ADMIN_INTERNAL_BIND'
    public static readonly EntitlementsSecretEnvVar = 'PRAGMATIC_ADMIN_ENTITLEMENTS_SECRET_FILE'
    public static readonly CustomerApiSecretEnvVar = 'PRAGMATIC_ADMIN_CUSTOMER_API_SECRET_FILE'
    public static readonly AllowedHostsEnvVar = 'PRAGMATIC_ADMIN_INTERNAL_ALLOWED_HOSTS'
    private static readonly HostSeparator = ','
    private static readonly WildcardBinds: ReadonlySet<string> = new Set(['0.0.0.0', '::'])
    public static readonly DefaultBind = '127.0.0.1'
    private static readonly DisabledPortText = '0'
    private static readonly MaxPort = 65535
    private static readonly LocalhostName = 'localhost'
    private static readonly BadPortPrefix = 'Invalid PRAGMATIC_ADMIN_INTERNAL_PORT (expected 0 or a port 1-65535): '
    private static readonly BadBindPrefix = 'Invalid PRAGMATIC_ADMIN_INTERNAL_BIND (expected an IP address or localhost): '
    private static readonly SecretRequired = 'PRAGMATIC_ADMIN_INTERNAL_PORT is set, so PRAGMATIC_INTERNAL_API_SECRET_FILE is required'
    private static readonly PortRequiredSuffix = ' is set, so PRAGMATIC_ADMIN_INTERNAL_PORT is required (the link is served on the internal listener)'

    public constructor(
        public readonly Port: number,
        public readonly Bind: string,
        public readonly SecretFile: string,
        public readonly EntitlementsSecretFile: string | undefined = undefined,
        public readonly CustomerApiSecretFile: string | undefined = undefined,
        public readonly Central: CentralLoginSettings | undefined = undefined,
        public readonly AllowedHosts: readonly string[] = [])
    {
    }

    /** The Host names the listener answers besides the loopback names: the bind address unless it is a wildcard, and
     *  the allowed hosts setting. */
    public get HostNames(): readonly string[]
    {
        const names = InternalSettings.WildcardBinds.has(this.Bind) ? [] : [this.Bind]
        return [...names, ...this.AllowedHosts]
    }

    /** Undefined when the internal listener is off (PRAGMATIC_ADMIN_INTERNAL_PORT blank or 0); a link setting without
     *  the listener is refused rather than dropped. */
    public static Of(env: NodeJS.ProcessEnv): InternalSettings | undefined
    {
        const S = InternalSettings
        const entitlements = S.Read(env, S.EntitlementsSecretEnvVar)
        const customer = S.Read(env, S.CustomerApiSecretEnvVar)
        const rawPort = S.Read(env, S.PortEnvVar) ?? ''
        if (rawPort === '' || rawPort === S.DisabledPortText)
        {
            const orphan = entitlements !== undefined ? S.EntitlementsSecretEnvVar : customer !== undefined ? S.CustomerApiSecretEnvVar : undefined
            if (orphan !== undefined)
            {
                throw new Error(orphan + S.PortRequiredSuffix)
            }
            return undefined
        }
        const port = Number(rawPort)
        if (!Number.isInteger(port) || port < 1 || port > S.MaxPort)
        {
            throw new Error(S.BadPortPrefix + rawPort)
        }
        const rawBind = S.Read(env, S.BindEnvVar) ?? ''
        const bind = rawBind === '' ? S.DefaultBind : rawBind
        if (isIP(bind) === 0 && bind !== S.LocalhostName)
        {
            throw new Error(S.BadBindPrefix + rawBind)
        }
        const secretFile = S.Read(env, InternalApiLink.SecretFileEnvVar)
        if (secretFile === undefined)
        {
            throw new Error(S.SecretRequired)
        }
        const hosts = (S.Read(env, S.AllowedHostsEnvVar) ?? '').split(S.HostSeparator).map(host => host.trim()).filter(host => host.length > 0)
        return new InternalSettings(port, bind, secretFile, entitlements, customer, customer === undefined ? undefined : CentralLoginSettings.Of(env), hosts)
    }

    /** The edge's internal API credential (the default link label); InternalApiLink's refusal names its setting. */
    public InternalCredential(): InternalApiCredential
    {
        return InternalApiLink.Credential(this.SecretFile)
    }

    /** The ledger's entitlements link credential, when that link is on. */
    public EntitlementsCredential(): InternalApiCredential | undefined
    {
        const file = this.EntitlementsSecretFile
        return file === undefined ? undefined : InternalSettings.Load(InternalSettings.EntitlementsSecretEnvVar, () => EntitlementsLink.CredentialFromFile(file))
    }

    /** The customer API link credential, when that link is on. */
    public CustomerApiCredential(): InternalApiCredential | undefined
    {
        const file = this.CustomerApiSecretFile
        return file === undefined ? undefined : InternalSettings.Load(InternalSettings.CustomerApiSecretEnvVar, () => CustomerApiLink.CredentialFromFile(file))
    }

    private static Load(setting: string, read: () => InternalApiCredential): InternalApiCredential
    {
        try
        {
            return read()
        }
        catch (err)
        {
            if (err instanceof InternalApiSecretError)
            {
                throw new InternalLinkSecretError(setting, err)
            }
            throw err
        }
    }

    private static Read(env: NodeJS.ProcessEnv, name: string): string | undefined
    {
        const value = env[name]?.trim() ?? ''
        return value === '' ? undefined : value
    }
}
