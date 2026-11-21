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

    /** The package roots (relative to the tree's parent) whose package.json is named `name`. */
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

class SingletonsFixture
{
    public static readonly RepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    public static readonly PortalRoot = join(SingletonsFixture.RepoRoot, 'portal')
    public static readonly ServerSingletons: readonly string[] = ['@pragmatic-tech-ai/todl-runtime', '@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/mural']
    public static readonly PortalSingletons: readonly string[] = ['@pragmatic-tech-ai/todl-runtime', '@pragmatic-tech-ai/mural']
}

describe('singletons', () =>
{
    it('installs exactly one copy of todl-runtime, todl and mural', () =>
    {
        const copies = new InstalledCopies(SingletonsFixture.RepoRoot)
        for (const name of SingletonsFixture.ServerSingletons)
        {
            assert.equal(copies.Of(name).length, 1, name + ': ' + JSON.stringify(copies.Of(name)))
        }
    })

    it('the portal, when installed, holds exactly one copy of todl-runtime and mural', (t) =>
    {
        if (!existsSync(join(SingletonsFixture.PortalRoot, 'node_modules')))
        {
            t.skip('portal not installed')
            return
        }
        const copies = new InstalledCopies(SingletonsFixture.PortalRoot)
        for (const name of SingletonsFixture.PortalSingletons)
        {
            assert.equal(copies.Of(name).length, 1, name + ': ' + JSON.stringify(copies.Of(name)))
        }
    })
})
