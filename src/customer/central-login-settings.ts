import { CentralLoginTokenVerifier } from '@pragmatic-tech-ai/pragmatic-identity-source-pragmatic'

/**
 * Where the console verifies customer admins' central-login tokens: the central realm's issuer, the audience the
 * tokens must carry (the personal cabinet's client id: the cabinet relays its own ID token) and an optional CA bundle
 * for a realm on a private CA (development stacks).
 */
export class CentralLoginSettings
{
    public static readonly IssuerEnvVar = 'PRAGMATIC_ADMIN_CENTRAL_ISSUER'
    public static readonly AudienceEnvVar = 'PRAGMATIC_ADMIN_CENTRAL_AUDIENCE'
    public static readonly CaBundleEnvVar = 'PRAGMATIC_ADMIN_OIDC_CA_BUNDLE'
    public static readonly DefaultAudience = 'pragmatic-cabinet'
    private static readonly HttpsPrefix = 'https://'
    private static readonly BadIssuer = 'PRAGMATIC_ADMIN_CENTRAL_ISSUER must be the https URL of the central login\'s issuer'

    public constructor(public readonly Issuer: string, public readonly Audience: string, public readonly CaBundleFile: string | undefined)
    {
    }

    public static Of(env: NodeJS.ProcessEnv): CentralLoginSettings
    {
        const S = CentralLoginSettings
        const issuer = S.Read(env, S.IssuerEnvVar) ?? CentralLoginTokenVerifier.Issuer
        if (!issuer.startsWith(S.HttpsPrefix))
        {
            throw new Error(S.BadIssuer)
        }
        return new CentralLoginSettings(issuer, S.Read(env, S.AudienceEnvVar) ?? S.DefaultAudience, S.Read(env, S.CaBundleEnvVar))
    }

    private static Read(env: NodeJS.ProcessEnv, name: string): string | undefined
    {
        const value = env[name]?.trim() ?? ''
        return value === '' ? undefined : value
    }
}
