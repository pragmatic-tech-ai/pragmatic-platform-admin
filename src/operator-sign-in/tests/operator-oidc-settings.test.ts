import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { OperatorOidcSettings, OperatorOidcSettingsError } from '../operator-oidc-settings.js'

class SettingsFixture
{
    public static readonly Issuer = 'https://idp-pragmatic-001.staff.pragmatic-tech.ai/realms/pragmatic-001'
    public static readonly PublicUrl = 'https://admin.pragmatic-tech.ai'
    public static readonly ClientId = 'pragmatic-platform-admin'
    public static readonly Secret = 'a-client-secret-value'

    public static Env(secretFile: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv
    {
        const S = OperatorOidcSettings
        return {
            [S.IssuerEnvVar]: SettingsFixture.Issuer,
            [S.ClientIdEnvVar]: SettingsFixture.ClientId,
            [S.ClientSecretFileEnvVar]: secretFile,
            [S.PublicUrlEnvVar]: SettingsFixture.PublicUrl,
            ...extra,
        }
    }

    public static Refuses(env: NodeJS.ProcessEnv, names: string): void
    {
        assert.throws(() => OperatorOidcSettings.Of(env), (err: Error) => err instanceof OperatorOidcSettingsError && err.message.includes(names) && !err.message.includes(SettingsFixture.Secret))
    }
}

describe('OperatorOidcSettings', () =>
{
    const F = SettingsFixture
    const S = OperatorOidcSettings
    let root: string
    let secretFile: string

    beforeEach(() =>
    {
        root = mkdtempSync(join(tmpdir(), 'cp-operator-oidc-'))
        secretFile = join(root, 'secret')
        writeFileSync(secretFile, F.Secret + '\n')
    })

    afterEach(() =>
    {
        rmSync(root, { recursive: true, force: true })
    })

    it('is off when no setting of the option is set', () =>
    {
        assert.equal(S.Of({}), undefined)
        assert.equal(S.Of({ [S.PublicUrlEnvVar]: F.PublicUrl }), undefined)
    })

    it('reads the option: discovery defaults to the issuer, the redirect is under the public URL, the secret from its file', () =>
    {
        const settings = S.Of(F.Env(secretFile, { [S.PublicUrlEnvVar]: F.PublicUrl + '/' }))
        assert.ok(settings !== undefined)
        assert.equal(settings.Issuer, F.Issuer)
        assert.equal(settings.DiscoveryUrl, F.Issuer + '/.well-known/openid-configuration')
        assert.equal(settings.RedirectUri, F.PublicUrl + '/auth/oidc/callback')
        assert.equal(settings.ClientSecret, F.Secret)
        assert.equal(settings.CaBundleFile, undefined)
    })

    it('keeps the issuer verbatim (a trailing slash too: tokens are matched byte for byte)', () =>
    {
        const settings = S.Of(F.Env(secretFile, { [S.IssuerEnvVar]: F.Issuer + '/' }))
        assert.equal(settings?.Issuer, F.Issuer + '/')
        assert.equal(settings?.DiscoveryUrl, F.Issuer + '/.well-known/openid-configuration')
    })

    it('takes an explicit discovery URL and CA bundle', () =>
    {
        const settings = S.Of(F.Env(secretFile, { [S.DiscoveryUrlEnvVar]: 'https://internal.example/realms/r/.well-known/openid-configuration', [S.CaBundleFileEnvVar]: '/run/ca.pem' }))
        assert.equal(settings?.DiscoveryUrl, 'https://internal.example/realms/r/.well-known/openid-configuration')
        assert.equal(settings?.CaBundleFile, '/run/ca.pem')
    })

    it('refuses a half-set option, naming the missing setting', () =>
    {
        F.Refuses({ [S.ClientIdEnvVar]: F.ClientId }, S.IssuerEnvVar)
        for (const name of [S.ClientIdEnvVar, S.ClientSecretFileEnvVar, S.PublicUrlEnvVar])
        {
            const env = F.Env(secretFile)
            delete env[name]
            F.Refuses(env, name)
        }
    })

    it('refuses an issuer or public URL that is not https (http only on loopback) or carries a query', () =>
    {
        F.Refuses(F.Env(secretFile, { [S.IssuerEnvVar]: 'http://realm.example/realms/r' }), S.IssuerEnvVar)
        F.Refuses(F.Env(secretFile, { [S.PublicUrlEnvVar]: 'https://admin.example/?x=1' }), S.PublicUrlEnvVar)
        F.Refuses(F.Env(secretFile, { [S.IssuerEnvVar]: 'not a url' }), S.IssuerEnvVar)
        assert.equal(S.Of(F.Env(secretFile, { [S.PublicUrlEnvVar]: 'http://127.0.0.1:7000' }))?.RedirectUri, 'http://127.0.0.1:7000/auth/oidc/callback')
    })

    it('refuses a public URL with a path (the console sits at its origin\'s root)', () =>
    {
        F.Refuses(F.Env(secretFile, { [S.PublicUrlEnvVar]: F.PublicUrl + '/admin' }), S.PublicUrlEnvVar)
    })

    it('refuses an unreadable or blank or multi-line secret file without naming its content', () =>
    {
        F.Refuses(F.Env(join(root, 'missing')), S.ClientSecretFileEnvVar)
        writeFileSync(secretFile, '  \n')
        F.Refuses(F.Env(secretFile), S.ClientSecretFileEnvVar)
        writeFileSync(secretFile, F.Secret + '\n' + F.Secret + '\n')
        F.Refuses(F.Env(secretFile), S.ClientSecretFileEnvVar)
    })
})
