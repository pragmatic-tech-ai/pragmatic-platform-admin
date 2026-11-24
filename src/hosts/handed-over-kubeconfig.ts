/** A handed-over credential is not exactly the kubeconfig a host agent builds. Says which rule, never the content. */
export class HandedOverKubeconfigError extends Error
{
    private static readonly ErrorName = 'HandedOverKubeconfigError'
    private static readonly Prefix = 'the handed-over kubeconfig is refused: '

    public constructor(reason: string)
    {
        super(HandedOverKubeconfigError.Prefix + reason)
        this.name = HandedOverKubeconfigError.ErrorName
    }
}

/**
 * What the platform keeps of a hosted cluster's handed-over kubeconfig (C5.1): the cluster's CA and the
 * ServiceAccount token, nothing else. Parse takes exactly the JSON kubeconfig a host agent builds (apiVersion v1, kind
 * Config, one cluster with only `server` and `certificate-authority-data`, one user with only a `token`, one context
 * naming them, current-context set) and refuses anything more: exec or auth-provider users, client keys or files,
 * proxy-url, insecure-skip-tls-verify, extensions, any extra member. Its `server` must be https on the host's mesh
 * address. Rebuild writes a kubeconfig of the platform's own shape whose server is the host's mesh address and the
 * placement's port, so no handed-over field but the CA and the token ever reaches kubectl.
 */
export class HandedOverKubeconfig
{
    public static readonly MaxTokenChars = 8192
    public static readonly MaxCaChars = 65536
    private static readonly ApiVersion = 'v1'
    private static readonly Kind = 'Config'
    private static readonly TopKeys = ['apiVersion', 'clusters', 'contexts', 'current-context', 'kind', 'users']
    private static readonly NamedClusterKeys = ['cluster', 'name']
    private static readonly ClusterKeys = ['certificate-authority-data', 'server']
    private static readonly NamedUserKeys = ['name', 'user']
    private static readonly UserKeys = ['token']
    private static readonly NamedContextKeys = ['context', 'name']
    private static readonly ContextKeys = ['cluster', 'user']
    private static readonly HttpsScheme = 'https:'
    private static readonly IPv6Open = '['
    private static readonly IPv6Close = ']'
    private static readonly Base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/
    private static readonly TokenPattern = /^[A-Za-z0-9._-]+$/
    private static readonly CertificateMarker = '-----BEGIN CERTIFICATE-----'
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly Name = 'pragmatic-hosted'
    private static readonly Redacted = '[HandedOverKubeconfig: redacted]'
    private static readonly HttpsPrefix = 'https://'
    private static readonly PortSeparator = ':'
    private static readonly NotJson = 'not a JSON object'
    private static readonly BadShape = 'not exactly one cluster, user and context of the agent\'s shape'
    private static readonly BadServer = 'the server is not https on the host\'s mesh address'
    private static readonly BadCa = 'the certificate authority is not a base64 PEM certificate'
    private static readonly BadToken = 'the user is not a bearer token'

    private constructor(public readonly CertificateAuthorityData: string, private readonly token: string, public readonly Port: number)
    {
    }

    /** The CA, token and server port of a kubeconfig the host at `meshAddress` handed over; throws HandedOverKubeconfigError. */
    public static Parse(bytes: Buffer, meshAddress: string): HandedOverKubeconfig
    {
        const H = HandedOverKubeconfig
        let root: unknown
        try
        {
            root = JSON.parse(bytes.toString(H.Utf8))
        }
        catch
        {
            throw new HandedOverKubeconfigError(H.NotJson)
        }
        const top = H.Exactly(root, H.TopKeys)
        if (top.apiVersion !== H.ApiVersion || top.kind !== H.Kind)
        {
            throw new HandedOverKubeconfigError(H.BadShape)
        }
        const named = H.One(top.clusters, H.NamedClusterKeys)
        const cluster = H.Exactly(named.cluster, H.ClusterKeys)
        const namedUser = H.One(top.users, H.NamedUserKeys)
        const user = H.Exactly(namedUser.user, H.UserKeys)
        const namedContext = H.One(top.contexts, H.NamedContextKeys)
        const context = H.Exactly(namedContext.context, H.ContextKeys)
        if (typeof named.name !== 'string' || typeof namedUser.name !== 'string' || context.cluster !== named.name || context.user !== namedUser.name
            || top['current-context'] !== namedContext.name)
        {
            throw new HandedOverKubeconfigError(H.BadShape)
        }
        const port = H.PortOf(cluster.server, meshAddress)
        const ca = cluster['certificate-authority-data']
        if (typeof ca !== 'string' || ca.length > H.MaxCaChars || !H.Base64Pattern.test(ca) || !Buffer.from(ca, H.Base64).toString(H.Utf8).includes(H.CertificateMarker))
        {
            throw new HandedOverKubeconfigError(H.BadCa)
        }
        const token = user.token
        if (typeof token !== 'string' || token.length === 0 || token.length > H.MaxTokenChars || !H.TokenPattern.test(token))
        {
            throw new HandedOverKubeconfigError(H.BadToken)
        }
        return new HandedOverKubeconfig(ca, token, port)
    }

    /** The kubeconfig the platform stores: its own names, the host's mesh address and `port`, the CA and the token. */
    public Rebuild(meshAddress: string, port: number): Buffer
    {
        const H = HandedOverKubeconfig
        const host = meshAddress.includes(H.PortSeparator) ? H.IPv6Open + meshAddress + H.IPv6Close : meshAddress
        const server = H.HttpsPrefix + host + H.PortSeparator + String(port)
        return Buffer.from(JSON.stringify({
            apiVersion: H.ApiVersion,
            kind: H.Kind,
            clusters: [{ name: H.Name, cluster: { server, 'certificate-authority-data': this.CertificateAuthorityData } }],
            users: [{ name: H.Name, user: { token: this.token } }],
            contexts: [{ name: H.Name, context: { cluster: H.Name, user: H.Name } }],
            'current-context': H.Name,
        }), H.Utf8)
    }

    public toJSON(): string
    {
        return HandedOverKubeconfig.Redacted
    }

    private static PortOf(server: unknown, meshAddress: string): number
    {
        const H = HandedOverKubeconfig
        let url: URL
        try
        {
            url = new URL(typeof server === 'string' ? server : '')
        }
        catch
        {
            throw new HandedOverKubeconfigError(H.BadServer)
        }
        const host = url.hostname.startsWith(H.IPv6Open) ? url.hostname.slice(1, -1) : url.hostname
        const port = Number(url.port)
        if (url.protocol !== H.HttpsScheme || host !== meshAddress.toLowerCase() || url.port === '' || !Number.isInteger(port)
            || url.username !== '' || url.password !== '' || (url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '')
        {
            throw new HandedOverKubeconfigError(H.BadServer)
        }
        return port
    }

    private static One(value: unknown, keys: readonly string[]): Record<string, unknown>
    {
        if (!Array.isArray(value) || value.length !== 1)
        {
            throw new HandedOverKubeconfigError(HandedOverKubeconfig.BadShape)
        }
        return HandedOverKubeconfig.Exactly(value[0], keys)
    }

    private static Exactly(value: unknown, keys: readonly string[]): Record<string, unknown>
    {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
        {
            throw new HandedOverKubeconfigError(HandedOverKubeconfig.BadShape)
        }
        const actual = Object.keys(value).sort()
        if (actual.length !== keys.length || actual.some((key, i) => key !== keys[i]))
        {
            throw new HandedOverKubeconfigError(HandedOverKubeconfig.BadShape)
        }
        return value as Record<string, unknown>
    }
}
