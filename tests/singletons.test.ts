import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Finds every installed copy of a package under a node_modules tree (nested node_modules included), by the `name` of
 * each package.json at a package root. Two copies of todl-runtime, todl or mural break `instanceof` across them.
 */
class InstalledCopies
{
    private static readonly NodeModules = 'node_modules'
    private static readonly PackageJson = 'package.json'
    private static readonly ScopePrefix = '@'
    private static readonly Utf8 = 'utf8'

    public constructor(private readonly root: string)
    {
    }

    /** The absolute package roots under the tree whose package.json is named `name`. */
    public Of(name: string): string[]
    {
        const found: string[] = []
        this.Walk(join(this.root, InstalledCopies.NodeModules), name, found)
        return found
    }

    private Walk(modules: string, name: string, found: string[]): void
    {
        if (!existsSync(modules))
        {
            return
        }
        for (const entry of readdirSync(modules, { withFileTypes: true }))
        {
            if (!entry.isDirectory() && !entry.isSymbolicLink())
            {
                continue
            }
            const path = join(modules, entry.name)
            if (entry.name.startsWith(InstalledCopies.ScopePrefix))
            {
                for (const scoped of readdirSync(path, { withFileTypes: true }))
                {
                    this.Visit(join(path, scoped.name), name, found)
                }
                continue
            }
            this.Visit(path, name, found)
        }
    }

    private Visit(packageRoot: string, name: string, found: string[]): void
    {
        const manifest = join(packageRoot, InstalledCopies.PackageJson)
        if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, InstalledCopies.Utf8)) as { name?: string }).name === name)
        {
            found.push(packageRoot)
        }
        this.Walk(join(packageRoot, InstalledCopies.NodeModules), name, found)
    }
}

/**
 * Reads the installed copies of a package from a package-lock.json (lockfile v2/v3 `packages` keys), so a UI folder is
 * checked without installing it: every key ending in `node_modules/<name>` is one copy npm ci would place.
 */
class LockedCopies
{
    private static readonly PackageLock = 'package-lock.json'
    private static readonly ModulesSegment = 'node_modules/'
    private static readonly Utf8 = 'utf8'

    private readonly keys: readonly string[]

    public constructor(root: string)
    {
        const lock = JSON.parse(readFileSync(join(root, LockedCopies.PackageLock), LockedCopies.Utf8)) as { packages?: Record<string, unknown> }
        this.keys = Object.keys(lock.packages ?? {})
    }

    /** The lock keys that install a copy of `name`. */
    public Of(name: string): string[]
    {
        const suffix = LockedCopies.ModulesSegment + name
        return this.keys.filter(key => key === suffix || key.endsWith('/' + suffix))
    }
}

class SingletonsFixture
{
    public static readonly RepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    public static readonly PortalRoot = join(SingletonsFixture.RepoRoot, 'portal')
    public static readonly ServerSingletons: readonly string[] = ['@pragmatic-tech-ai/todl-runtime', '@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/mural']
    public static readonly PortalSingletons: readonly string[] = ['@pragmatic-tech-ai/todl-runtime', '@pragmatic-tech-ai/mural']
    public static readonly DetailSeparator = ': '

    public static Detail(name: string, copies: readonly string[]): string
    {
        return name + SingletonsFixture.DetailSeparator + JSON.stringify(copies)
    }
}

describe('singletons', () =>
{
    it('installs exactly one copy of todl-runtime, todl and mural', () =>
    {
        const copies = new InstalledCopies(SingletonsFixture.RepoRoot)
        for (const name of SingletonsFixture.ServerSingletons)
        {
            const found = copies.Of(name)
            assert.equal(found.length, 1, SingletonsFixture.Detail(name, found))
        }
    })

    it('the portal lock installs exactly one copy of todl-runtime and mural', () =>
    {
        const copies = new LockedCopies(SingletonsFixture.PortalRoot)
        for (const name of SingletonsFixture.PortalSingletons)
        {
            const found = copies.Of(name)
            assert.equal(found.length, 1, SingletonsFixture.Detail(name, found))
        }
    })
})
