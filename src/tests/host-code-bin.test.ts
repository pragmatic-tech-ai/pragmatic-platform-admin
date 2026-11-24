import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MemoryRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { HostCodeBin, type IHostCodeIssuer } from '../bin/pragmatic-host-code.js'
import { EnrolmentCodeIssuer } from '../enrolment/enrolment-code-issuer.js'
import { EnrolmentAgentKind, EnrolmentCodeRegistry, type EnrolmentCodeRecord } from '../enrolment/enrolment-code-record.js'

class HostCodeBinFixture
{
    public static Capture(): { lines: string[]; write: (line: string) => void }
    {
        const lines: string[] = []
        return { lines, write: line => { lines.push(line) } }
    }

    public static async With(work: (dir: string) => Promise<void>): Promise<void>
    {
        const dir = mkdtempSync(join(tmpdir(), 'host-code-bin-'))
        try
        {
            await work(dir)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    /** Two registries over one record map: the command's process and the running console's. */
    public static async Shared(): Promise<{ Command: EnrolmentCodeIssuer; Console: EnrolmentCodeIssuer; ConsoleRegistry: EnrolmentCodeRegistry }>
    {
        const map = new MemoryRecordMap<EnrolmentCodeRecord>()
        const commandRegistry = new EnrolmentCodeRegistry(map)
        const consoleRegistry = new EnrolmentCodeRegistry(map)
        await consoleRegistry.Load()
        await commandRegistry.Load()
        return { Command: new EnrolmentCodeIssuer(commandRegistry), Console: new EnrolmentCodeIssuer(consoleRegistry), ConsoleRegistry: consoleRegistry }
    }
}

describe('HostCodeBin', () =>
{
    const F = HostCodeBinFixture
    it('parses issue-host-code --out <file> and refuses anything else (exit 2 with the usage line)', async () =>
    {
        assert.deepEqual({ ...HostCodeBin.Parse(['issue-host-code', '--out', 'code.txt']) }, { Out: resolve('code.txt') })
        assert.equal(HostCodeBin.Parse([]), undefined)
        assert.equal(HostCodeBin.Parse(['issue-host-code']), undefined)
        assert.equal(HostCodeBin.Parse(['issue-host-code', '--out', ' ']), undefined)
        assert.equal(HostCodeBin.Parse(['other', '--out', 'x']), undefined)
        const err = F.Capture()
        assert.equal(await HostCodeBin.Run(['--out', 'x'], {}, () => undefined, err.write), HostCodeBin.UsageExit)
        assert.match(err.lines.join('\n'), /usage: pragmatic-host-code/)
    })

    it('writes one host code (machine subject, 0600) to the file, prints only its expiry, and the running console redeems it', async () =>
    {
        await F.With(async dir =>
        {
            const shared = await F.Shared()
            const out = F.Capture()
            const path = join(dir, 'host-code')
            assert.equal(await HostCodeBin.Run([HostCodeBin.Command, HostCodeBin.OutFlag, path], {}, out.write, () => undefined, shared.Command), 0)
            const code = readFileSync(path, 'utf8').trim()
            assert.match(code, EnrolmentCodeIssuer.CodePattern)
            if (process.platform !== 'win32')
            {
                assert.equal(statSync(path).mode & 0o777, 0o600)
            }
            assert.equal(out.lines.length, 1)
            assert.match(out.lines[0] as string, /expires at \d{4}-\d{2}-\d{2}T/)
            assert.ok(!out.lines.join('').includes(code), 'never printed')
            assert.equal(shared.ConsoleRegistry.List().length, 0, 'the console has not seen it yet')
            const redeemed = await shared.Console.Redeem(code, EnrolmentCodeIssuer.HostExpectation())
            assert.equal(redeemed.agentKind, EnrolmentAgentKind.Host)
            assert.equal(redeemed.issuedBy, HostCodeBin.IssuedBy)
            assert.equal(Date.parse(redeemed.expiresAt) - Date.parse(redeemed.issuedAt), EnrolmentCodeIssuer.LifetimeMs)
        })
    })

    it('refuses an existing file (exit 3) and issues nothing', async () =>
    {
        await F.With(async dir =>
        {
            const path = join(dir, 'host-code')
            writeFileSync(path, 'keep me')
            let issued = 0
            const issuer: IHostCodeIssuer = { IssueHostCode: () => { issued++; return Promise.resolve({ Code: 'x', ExpiresAt: new Date() }) } }
            assert.equal(await HostCodeBin.Run([HostCodeBin.Command, HostCodeBin.OutFlag, path], {}, () => undefined, () => undefined, issuer), HostCodeBin.ExistsExit)
            assert.equal(issued, 0)
            assert.equal(readFileSync(path, 'utf8'), 'keep me')
        })
    })

    it('a failed issue removes the file it created (exit 1); without the database setting it names the setting', async () =>
    {
        await F.With(async dir =>
        {
            const path = join(dir, 'host-code')
            const failing: IHostCodeIssuer = { IssueHostCode: () => Promise.reject(new Error('database down')) }
            assert.equal(await HostCodeBin.Run([HostCodeBin.Command, HostCodeBin.OutFlag, path], {}, () => undefined, () => undefined, failing), HostCodeBin.FailedExit)
            assert.equal(existsSync(path), false)
            const err = F.Capture()
            assert.equal(await HostCodeBin.Run([HostCodeBin.Command, HostCodeBin.OutFlag, path], {}, () => undefined, err.write), HostCodeBin.FailedExit)
            assert.match(err.lines.join('\n'), /PRAGMATIC_ADMIN_DATABASE_URL_FILE/)
            assert.equal(existsSync(path), false)
        })
    })
})
