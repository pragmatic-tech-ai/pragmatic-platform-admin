import { readFileSync } from 'node:fs'

/** The operator sign-in option is set only in part, or one of its values is malformed (the message names settings, never values). */
export class OperatorOidcSettingsError extends Error
{
    private static readonly ErrorName = 'OperatorOidcSettingsError'

    public constructor(message: string)
    {
        super(message)
        this.name = OperatorOidcSettingsError.ErrorName
    }
}

/**
 * The `operatorSignIn` option of the platform admin console: operators sign in through their realm (the Pragmatic
 * tenant's staff realm) as an OIDC relying party, besides the break-glass operator password. Absent (no issuer set):
 * OIDC sign-in is off and only the password signs operators in. Present: the issuer, the client id, the client secret
 * file and the console's public URL are required; the discovery URL defaults to the issuer's well-known document and
 * the CA bundle (a realm on a private CA) is optional. The client secret is read from its file once, here; it is never
 * logged and no error names it.
 */
export class OperatorOidcSettings
{
    public static readonly IssuerEnvVar = 'PRAGMATIC_ADMIN_OPERATOR_OIDC_ISSUER'
    public static readonly DiscoveryUrlEnvVar = 'PRAGMATIC_ADMIN_OPERATOR_OIDC_DISCOVERY_URL'
    public static readonly ClientIdEnvVar = 'PRAGMATIC_ADMIN_OPERATOR_OIDC_CLIENT_ID'
    public static readonly ClientSecretFileEnvVar = 'PRAGMATIC_ADMIN_OPERATOR_OIDC_CLIENT_SECRET_FILE'
    public static readonly CaBundleFileEnvVar = 'PRAGMATIC_ADMIN_OPERATOR_OIDC_CA_BUNDLE_FILE'
    public static readonly PublicUrlEnvVar = 'PRAGMATIC_ADMIN_PUBLIC_URL'
    /** Where the realm sends the browser back (registered as the client's redirect URI), under the public URL. */
    public static readonly CallbackPath = '/auth/oidc/callback'
    public static readonly BeginPath = '/auth/oidc/begin'
    private static readonly WellKnownSuffix = '/.well-known/openid-configuration'
    private static readonly HttpsProtocol = 'https:'
    private static readonly HttpProtocol = 'http:'
    private static readonly LoopbackHosts: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])
    private static readonly TrailingSlashes = /\/+$/
    private static readonly TrailingNewline = /\r?\n$/
    private static readonly LineBreak = /[\r\n]/
    private static readonly Utf8 = 'utf8'
    private static readonly NoText = ''
    private static readonly RequiredSuffix = ' is required when ' + OperatorOidcSettings.IssuerEnvVar + ' is set'
    private static readonly UrlSuffix = ' must be an absolute https URL (http only on a loopback host), without query or fragment'
    private static readonly SecretUnreadableMessage = OperatorOidcSettings.ClientSecretFileEnvVar + ' must name a readable file'
    private static readonly SecretNotOneLineMessage = OperatorOidcSettings.ClientSecretFileEnvVar + ' must hold one non-blank line'
    private static readonly PartialMessage = OperatorOidcSettings.IssuerEnvVar + ' is required when another operator sign-in setting is set'

    private constructor(
        /** The realm's issuer, verbatim as its tokens carry it. */
        public readonly Issuer: string,
        public readonly DiscoveryUrl: string,
        public readonly ClientId: string,
        public readonly ClientSecret: string,
        /** The console's browser-facing origin (no trailing slash). */
        public readonly PublicUrl: string,
        public readonly CaBundleFile: string | undefined)
    {
        Object.freeze(this)
    }

    /** The redirect URI the client is registered with at the realm. */
    public get RedirectUri(): string
    {
        return this.PublicUrl + OperatorOidcSettings.CallbackPath
    }

    /** The option from the environment; undefined when OIDC operator sign-in is off (no setting of the option is set). */
    public static Of(env: NodeJS.ProcessEnv): OperatorOidcSettings | undefined
    {
        const S = OperatorOidcSettings
        const issuer = S.Value(env, S.IssuerEnvVar)
        if (issuer === undefined)
        {
            const others = [S.DiscoveryUrlEnvVar, S.ClientIdEnvVar, S.ClientSecretFileEnvVar, S.CaBundleFileEnvVar]
            if (others.some(name => S.Value(env, name) !== undefined))
            {
                throw new OperatorOidcSettingsError(S.PartialMessage)
            }
            return undefined
        }
        const clientId = S.Required(env, S.ClientIdEnvVar)
        const secretFile = S.Required(env, S.ClientSecretFileEnvVar)
        // The public URL is an origin the callback path is appended to: its trailing slashes go.
        const publicUrl = S.Url(S.Required(env, S.PublicUrlEnvVar), S.PublicUrlEnvVar).replace(S.TrailingSlashes, S.NoText)
        const trimmedIssuer = S.Url(issuer, S.IssuerEnvVar)
        const discovery = S.Value(env, S.DiscoveryUrlEnvVar)
        const discoveryUrl = discovery === undefined ? trimmedIssuer.replace(S.TrailingSlashes, S.NoText) + S.WellKnownSuffix : S.Url(discovery, S.DiscoveryUrlEnvVar)
        return new OperatorOidcSettings(trimmedIssuer, discoveryUrl, clientId, S.ReadSecret(secretFile), publicUrl, S.Value(env, S.CaBundleFileEnvVar))
    }

    private static Value(env: NodeJS.ProcessEnv, name: string): string | undefined
    {
        const value = env[name]?.trim() ?? OperatorOidcSettings.NoText
        return value === OperatorOidcSettings.NoText ? undefined : value
    }

    private static Required(env: NodeJS.ProcessEnv, name: string): string
    {
        const value = OperatorOidcSettings.Value(env, name)
        if (value === undefined)
        {
            throw new OperatorOidcSettingsError(name + OperatorOidcSettings.RequiredSuffix)
        }
        return value
    }

    /** An absolute https URL (http on a loopback host only), without query or fragment, kept verbatim (an issuer is
     *  compared byte for byte with the tokens' `iss`). */
    private static Url(text: string, name: string): string
    {
        const S = OperatorOidcSettings
        let url: URL
        try
        {
            url = new URL(text)
        }
        catch
        {
            throw new OperatorOidcSettingsError(name + S.UrlSuffix)
        }
        const secure = url.protocol === S.HttpsProtocol || (url.protocol === S.HttpProtocol && S.LoopbackHosts.has(url.hostname))
        if (!secure || url.search !== S.NoText || url.hash !== S.NoText || url.username !== S.NoText || url.password !== S.NoText)
        {
            throw new OperatorOidcSettingsError(name + S.UrlSuffix)
        }
        return text
    }

    private static ReadSecret(file: string): string
    {
        const S = OperatorOidcSettings
        let content: string
        try
        {
            content = readFileSync(file, S.Utf8)
        }
        catch
        {
            throw new OperatorOidcSettingsError(S.SecretUnreadableMessage)
        }
        const secret = content.replace(S.TrailingNewline, S.NoText)
        if (secret.trim() === S.NoText || S.LineBreak.test(secret))
        {
            throw new OperatorOidcSettingsError(S.SecretNotOneLineMessage)
        }
        return secret
    }
}
