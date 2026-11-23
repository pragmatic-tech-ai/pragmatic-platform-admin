import { CentralLoginSubjectVerifier } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { CentralLoginSubject, ICentralLoginVerifier } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CustomerApiError, CustomerErrorCode } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { TokenVerifierUnavailableError } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { IHttpClient } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { CentralLoginTokenVerifier } from '@pragmatic-tech-ai/pragmatic-identity-source-pragmatic'
import type { CentralLoginSettings } from './central-login-settings.js'

/**
 * The console's verifier of customer admins: a central-login ID token of the configured issuer and audience (signature
 * on the issuer's keys, expiry, an email) names its CentralLoginSubject; any other token is undefined (`not-signed-in`).
 * When the issuer's keys cannot be fetched the verifier cannot decide: that is `unavailable` (503), never
 * `not-signed-in`, so a central-login outage does not read as the customer's fault.
 */
export class CentralLoginVerifiers implements ICentralLoginVerifier
{
    private constructor(private readonly inner: ICentralLoginVerifier)
    {
    }

    /** `http`: the client for discovery and keys (tests); default from the settings' CA bundle. */
    public static Create(settings: CentralLoginSettings, http?: IHttpClient): ICentralLoginVerifier
    {
        const tokens = new CentralLoginTokenVerifier({ Issuer: settings.Issuer, Audience: settings.Audience, CaBundleFile: settings.CaBundleFile, Http: http })
        return new CentralLoginVerifiers(new CentralLoginSubjectVerifier(tokens))
    }

    public async Verify(token: string): Promise<CentralLoginSubject | undefined>
    {
        try
        {
            return await this.inner.Verify(token)
        }
        catch (err)
        {
            if (err instanceof TokenVerifierUnavailableError)
            {
                throw new CustomerApiError(CustomerErrorCode.Unavailable)
            }
            throw err
        }
    }
}
