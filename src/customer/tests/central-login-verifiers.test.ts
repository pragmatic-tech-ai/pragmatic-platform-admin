import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { FakeOidcHttpClient, FakeOidcIdp, TlsTestRealm } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import type { TlsTestRealmRoute } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import type { IHttpClient } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { CustomerApiError, CustomerErrorCode } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { CentralLoginTokenVerifier } from '@pragmatic-tech-ai/pragmatic-identity-source-pragmatic'
import { CentralLoginSettings } from '../central-login-settings.js'
import { CentralLoginVerifiers } from '../central-login-verifiers.js'

/** An issuer that never answers. */
class UnreachableHttp implements IHttpClient
{
    private static readonly Refused = 'connect ECONNREFUSED'

    public GetJson(): Promise<unknown>
    {
        return Promise.reject(new Error(UnreachableHttp.Refused))
    }

    public PostForm(): Promise<unknown>
    {
        return Promise.reject(new Error(UnreachableHttp.Refused))
    }
}

class VerifierFixture
{
    public static readonly CentralIssuer = 'https://login.dev.test/realms/central'
    public static readonly TenantIssuer = 'https://login.dev.test/realms/acme'
    public static readonly Audience = 'pragmatic-cabinet'
    public static readonly OtherAudience = 'pragmatic-ledger'
    public static readonly Subject = 'gip-uid-1'
    public static readonly Email = 'ada@customer.test'
    public static readonly CentralPath = '/realms/central'
    public static readonly DiscoveryPath = '/.well-known/openid-configuration'
    public static readonly JwksPath = '/jwks'
    public static readonly HmacKey = 'shared-secret-shared-secret-shared'

    public static Claims(audience: string = VerifierFixture.Audience): Record<string, unknown>
    {
        return { sub: VerifierFixture.Subject, aud: audience, email: VerifierFixture.Email, email_verified: true }
    }

    public static Settings(issuer: string = VerifierFixture.CentralIssuer, caBundle?: string): CentralLoginSettings
    {
        return new CentralLoginSettings(issuer, VerifierFixture.Audience, caBundle)
    }

    /** A token signed with a symmetric key (alg HS256): must never verify. */
    public static Hs256(issuer: string): string
    {
        const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
        const now = Math.floor(Date.now() / 1000)
        const head = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ ...VerifierFixture.Claims(), iss: issuer, iat: now, exp: now + 300 })
        return head + '.' + createHmac('sha256', VerifierFixture.HmacKey).update(head).digest('base64url')
    }
}

describe('CentralLoginVerifiers', () =>
{
    const F = VerifierFixture

    it('accepts a cabinet ID token from the central issuer', async () =>
    {
        const idp = await FakeOidcIdp.Create(F.CentralIssuer)
        const verifier = CentralLoginVerifiers.Create(F.Settings(), new FakeOidcHttpClient(idp))
        const subject = await verifier.Verify(await idp.MintIdToken(F.Claims()))
        assert.equal(subject?.Issuer, F.CentralIssuer)
        assert.equal(subject?.Subject, F.Subject)
        assert.equal(subject?.Email, F.Email)
    })

    it('refuses a token for another audience', async () =>
    {
        const idp = await FakeOidcIdp.Create(F.CentralIssuer)
        const verifier = CentralLoginVerifiers.Create(F.Settings(), new FakeOidcHttpClient(idp))
        assert.equal(await verifier.Verify(await idp.MintIdToken(F.Claims(F.OtherAudience))), undefined)
    })

    it('refuses a token from a tenant realm\'s issuer', async () =>
    {
        const central = await FakeOidcIdp.Create(F.CentralIssuer)
        const tenant = await FakeOidcIdp.Create(F.TenantIssuer)
        const verifier = CentralLoginVerifiers.Create(F.Settings(), new FakeOidcHttpClient(central))
        // Signed by the tenant realm and naming it.
        assert.equal(await verifier.Verify(await tenant.MintIdToken(F.Claims())), undefined)
        // Signed by the tenant realm but claiming the central issuer.
        assert.equal(await verifier.Verify(await tenant.MintIdToken(F.Claims(), { issuer: F.CentralIssuer })), undefined)
    })

    it('refuses HS256, unsigned and expired tokens', async () =>
    {
        const idp = await FakeOidcIdp.Create(F.CentralIssuer)
        const verifier = CentralLoginVerifiers.Create(F.Settings(), new FakeOidcHttpClient(idp))
        assert.equal(await verifier.Verify(F.Hs256(F.CentralIssuer)), undefined)
        assert.equal(await verifier.Verify(idp.MintRawUnsigned({ ...F.Claims(), iss: F.CentralIssuer })), undefined)
        assert.equal(await verifier.Verify(await idp.MintIdToken(F.Claims(), { expSecondsFromNow: -3600 })), undefined)
    })

    it('the issuer unreachable answers unavailable (503), not not-signed-in', async () =>
    {
        const idp = await FakeOidcIdp.Create(F.CentralIssuer)
        const token = await idp.MintIdToken(F.Claims())
        const verifier = CentralLoginVerifiers.Create(F.Settings(), new UnreachableHttp())
        await assert.rejects(verifier.Verify(token), (err: unknown) => err instanceof CustomerApiError && err.CustomerCode === CustomerErrorCode.Unavailable && err.Status === 503)
    })

    it('trusts a central realm on a private CA through the CA bundle, and only then', async () =>
    {
        const routes = new Map<string, TlsTestRealmRoute>()
        const realm = await TlsTestRealm.Start(routes)
        try
        {
            const issuer = realm.Url(F.CentralPath)
            const idp = await FakeOidcIdp.Create(issuer)
            routes.set(F.CentralPath + F.DiscoveryPath, () => idp.DiscoveryDocument())
            routes.set(F.CentralPath + F.JwksPath, () => idp.Jwks())
            const token = await idp.MintIdToken(F.Claims())
            assert.equal((await CentralLoginVerifiers.Create(F.Settings(issuer, TlsTestRealm.CaFile)).Verify(token))?.Subject, F.Subject)
            await assert.rejects(CentralLoginVerifiers.Create(F.Settings(issuer)).Verify(token), (err: unknown) => err instanceof CustomerApiError && err.CustomerCode === CustomerErrorCode.Unavailable)
        }
        finally
        {
            await realm.Stop()
        }
    })
})

describe('CentralLoginSettings', () =>
{
    it('defaults to the central realm and the cabinet audience', () =>
    {
        const settings = CentralLoginSettings.Of({})
        assert.equal(settings.Issuer, CentralLoginTokenVerifier.Issuer)
        assert.equal(settings.Audience, CentralLoginSettings.DefaultAudience)
        assert.equal(settings.CaBundleFile, undefined)
    })

    it('reads the issuer, audience and CA bundle, and refuses a non-https issuer naming the variable', () =>
    {
        const settings = CentralLoginSettings.Of({ PRAGMATIC_ADMIN_CENTRAL_ISSUER: VerifierFixture.CentralIssuer, PRAGMATIC_ADMIN_CENTRAL_AUDIENCE: VerifierFixture.OtherAudience, PRAGMATIC_ADMIN_OIDC_CA_BUNDLE: '/run/ca.pem' })
        assert.deepEqual([settings.Issuer, settings.Audience, settings.CaBundleFile], [VerifierFixture.CentralIssuer, VerifierFixture.OtherAudience, '/run/ca.pem'])
        assert.throws(() => CentralLoginSettings.Of({ PRAGMATIC_ADMIN_CENTRAL_ISSUER: 'http://login.dev.test' }), /PRAGMATIC_ADMIN_CENTRAL_ISSUER/)
    })
})
