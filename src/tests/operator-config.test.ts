import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ControlPlaneServer } from '../server.js'

describe('ControlPlaneServer.ReadOperatorOptions', () =>
{
    it('uses defaults when env is empty', () =>
    {
        const o = ControlPlaneServer.ReadOperatorOptions({}, '/data')
        assert.equal(o.operatorEmail, 'admin@control-plane.test')
        assert.equal(o.masterKeyFile, join('/data', 'master.key'))
        // Ruling (storage shape): the operator identity lives in the console's database, so there is no identity folder.
        assert.ok(!('identityRoot' in o))
        assert.equal(o.secureCookie, false)
        assert.equal(o.initialPassword, undefined)
    })

    it('honors all env vars', () =>
    {
        const o = ControlPlaneServer.ReadOperatorOptions({
            PRAGMATIC_ADMIN_MASTER_KEY_FILE: '/k/mk',
            PRAGMATIC_ADMIN_OPERATOR_EMAIL: 'op@x.test',
            PRAGMATIC_ADMIN_OPERATOR_PASSWORD: 'pw',
            PRAGMATIC_ADMIN_SECURE_COOKIE: 'true',
        }, '/data')
        assert.equal(o.masterKeyFile, '/k/mk')
        assert.equal(o.operatorEmail, 'op@x.test')
        assert.equal(o.initialPassword, 'pw')
        assert.equal(o.secureCookie, true)
    })

    it('treats an empty password as undefined', () =>
    {
        const o = ControlPlaneServer.ReadOperatorOptions({ PRAGMATIC_ADMIN_OPERATOR_PASSWORD: '' }, '/data')
        assert.equal(o.initialPassword, undefined)
    })

    it('accepts 1 for secureCookie and rejects other values', () =>
    {
        assert.equal(ControlPlaneServer.ReadOperatorOptions({ PRAGMATIC_ADMIN_SECURE_COOKIE: '1' }, '/data').secureCookie, true)
        assert.equal(ControlPlaneServer.ReadOperatorOptions({ PRAGMATIC_ADMIN_SECURE_COOKIE: 'yes' }, '/data').secureCookie, false)
    })
})

class SeedFileFixture
{
    public static readonly Root = mkdtempSync(join(tmpdir(), 'operator-seed-'))
    public static readonly Setting = 'PRAGMATIC_ADMIN_OPERATOR_PASSWORD_FILE'
    public static readonly ValueSetting = 'PRAGMATIC_ADMIN_OPERATOR_PASSWORD'

    public static File(name: string, content: string): string
    {
        const path = join(SeedFileFixture.Root, name)
        writeFileSync(path, content, { mode: 0o600 })
        return path
    }
}

describe('ControlPlaneServer.ReadOperatorOptions with a password file', () =>
{
    after(() => rmSync(SeedFileFixture.Root, { recursive: true, force: true }))

    it('reads the initial password from PRAGMATIC_ADMIN_OPERATOR_PASSWORD_FILE, stripping one trailing newline', () =>
    {
        const lf = SeedFileFixture.File('lf', 'seed-pw-123\n')
        const crlf = SeedFileFixture.File('crlf', 'seed-pw-456\r\n')
        const bare = SeedFileFixture.File('bare', ' spaced pw \n')
        assert.equal(ControlPlaneServer.ReadOperatorOptions({ [SeedFileFixture.Setting]: lf }, '/data').initialPassword, 'seed-pw-123')
        assert.equal(ControlPlaneServer.ReadOperatorOptions({ [SeedFileFixture.Setting]: crlf }, '/data').initialPassword, 'seed-pw-456')
        assert.equal(ControlPlaneServer.ReadOperatorOptions({ [SeedFileFixture.Setting]: bare }, '/data').initialPassword, ' spaced pw ')
    })

    it('refuses both the password and the password file, naming both and echoing neither', () =>
    {
        const file = SeedFileFixture.File('both', 'FILE-SECRET')
        assert.throws(() => ControlPlaneServer.ReadOperatorOptions({ [SeedFileFixture.Setting]: file, [SeedFileFixture.ValueSetting]: 'ENV-SECRET' }, '/data'), (e: Error) =>
        {
            assert.match(e.message, /PRAGMATIC_ADMIN_OPERATOR_PASSWORD_FILE/)
            assert.match(e.message, /PRAGMATIC_ADMIN_OPERATOR_PASSWORD(?!_)/)
            assert.ok(!e.message.includes('FILE-SECRET') && !e.message.includes('ENV-SECRET'))
            return true
        })
    })

    it('refuses a missing, blank or multi-line password file (it could never be typed), naming the setting only', () =>
    {
        for (const path of [join(SeedFileFixture.Root, 'nope'), SeedFileFixture.File('empty', ''), SeedFileFixture.File('newline', '\n'),
            SeedFileFixture.File('blank', '   \n'), SeedFileFixture.File('double', 'pw\n\n'), SeedFileFixture.File('inner', 'pw\nmore')])
        {
            assert.throws(() => ControlPlaneServer.ReadOperatorOptions({ [SeedFileFixture.Setting]: path }, '/data'), (e: Error) =>
            {
                assert.match(e.message, /PRAGMATIC_ADMIN_OPERATOR_PASSWORD_FILE/)
                assert.ok(!e.message.includes(SeedFileFixture.Root))
                return true
            })
        }
    })

    it('treats a blank file setting as unset, so the value setting still works', () =>
    {
        assert.equal(ControlPlaneServer.ReadOperatorOptions({ [SeedFileFixture.Setting]: '' }, '/data').initialPassword, undefined)
        assert.equal(ControlPlaneServer.ReadOperatorOptions({ [SeedFileFixture.Setting]: ' ', [SeedFileFixture.ValueSetting]: 'pw' }, '/data').initialPassword, 'pw')
    })
})

describe('ControlPlaneServer.AdminBindOf', () =>
{
    it('defaults to loopback', () =>
    {
        assert.equal(ControlPlaneServer.AdminBindOf({}), '127.0.0.1')
    })

    it('honors an explicit address', () =>
    {
        assert.equal(ControlPlaneServer.AdminBindOf({ PRAGMATIC_ADMIN_BIND: '0.0.0.0' }), '0.0.0.0')
        assert.equal(ControlPlaneServer.AdminBindOf({ PRAGMATIC_ADMIN_BIND: '::' }), '::')
    })

    it('treats blank as unset', () =>
    {
        assert.equal(ControlPlaneServer.AdminBindOf({ PRAGMATIC_ADMIN_BIND: ' ' }), '127.0.0.1')
    })

    it('rejects a value that is not an address, naming the setting', () =>
    {
        assert.throws(() => ControlPlaneServer.AdminBindOf({ PRAGMATIC_ADMIN_BIND: 'not an ip' }), /PRAGMATIC_ADMIN_BIND/)
    })
})

describe('ControlPlaneServer.OperatorOidcOf', () =>
{
    const issuer = 'https://idp.example/realms/r'

    it('a flawed operator sign-in option turns staff sign-in off instead of stopping the console (break-glass stays)', () =>
    {
        assert.equal(ControlPlaneServer.OperatorOidcOf({}), undefined)
        assert.equal(ControlPlaneServer.OperatorOidcOf({ PRAGMATIC_ADMIN_OPERATOR_OIDC_CLIENT_ID: 'c' }), undefined)
        assert.equal(ControlPlaneServer.OperatorOidcOf({ PRAGMATIC_ADMIN_OPERATOR_OIDC_ISSUER: issuer, PRAGMATIC_ADMIN_OPERATOR_OIDC_CLIENT_ID: 'c',
            PRAGMATIC_ADMIN_OPERATOR_OIDC_CLIENT_SECRET_FILE: join(tmpdir(), 'no-such-operator-secret'), PRAGMATIC_ADMIN_PUBLIC_URL: 'https://admin.example' }), undefined)
    })

    it('a complete option is read', () =>
    {
        const root = mkdtempSync(join(tmpdir(), 'cp-oidc-of-'))
        try
        {
            const secret = join(root, 'secret')
            writeFileSync(secret, 's3cret\n')
            const settings = ControlPlaneServer.OperatorOidcOf({ PRAGMATIC_ADMIN_OPERATOR_OIDC_ISSUER: issuer, PRAGMATIC_ADMIN_OPERATOR_OIDC_CLIENT_ID: 'c',
                PRAGMATIC_ADMIN_OPERATOR_OIDC_CLIENT_SECRET_FILE: secret, PRAGMATIC_ADMIN_PUBLIC_URL: 'https://admin.example' })
            assert.equal(settings?.Issuer, issuer)
        }
        finally
        {
            rmSync(root, { recursive: true, force: true })
        }
    })
})
