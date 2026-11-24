type Obj = Record<string, any>

/** A fake kubectl's record of its applies: the calls in order, and the manifests of each kind of apply. */
export interface IRecordedApplies
{
    readonly Calls: string[][]
    readonly ServerApplied: string[]
    readonly Applied: string[]
}

/**
 * Which agent environment variables a Deployment keeps after a series of applies, by field ownership as the API server
 * keeps it (C3.1 live proof early.13, row 4). A server-side apply by a manager owns exactly the entries it applied and
 * drops an entry it owned before and no longer applies when no other manager owns it; kubectl's server-side apply first
 * moves what kubectl's client-side apply owned to its own manager and drops kubectl's record of that apply (the live
 * agent's managed fields after the early.13 install: `pragmatic-control-plane` owns PRAGMATIC_AGENT_TOKEN, the client-side
 * manager only what the roll applied). A client-side apply deletes only what its record lists and the new object does not.
 */
export class AgentEnvOwnership
{
    public static readonly ServerManager = 'pragmatic-control-plane'
    public static readonly ClientManager = 'kubectl-client-side-apply'

    private readonly owners = new Map<string, Set<string>>()
    private record: string[] | undefined

    public constructor(owned: Record<string, readonly string[]>, record: readonly string[] | undefined)
    {
        for (const [manager, names] of Object.entries(owned))
        {
            for (const name of names) this.Owners(name).add(manager)
        }
        this.record = record === undefined ? undefined : [...record]
    }

    public get Names(): string[]
    {
        return [...this.owners.keys()].sort()
    }

    public ServerSide(names: readonly string[]): void
    {
        const M = AgentEnvOwnership
        for (const owners of this.owners.values())
        {
            if (owners.delete(M.ClientManager)) owners.add(M.ServerManager)
        }
        this.record = undefined
        for (const [name, owners] of [...this.owners])
        {
            if (!names.includes(name) && owners.delete(M.ServerManager) && owners.size === 0) this.owners.delete(name)
        }
        for (const name of names) this.Owners(name).add(M.ServerManager)
    }

    public ClientSide(names: readonly string[]): void
    {
        for (const name of this.record ?? [])
        {
            if (!names.includes(name)) this.owners.delete(name)
        }
        for (const name of names) this.Owners(name).add(AgentEnvOwnership.ClientManager)
        this.record = [...names]
    }

    /** Replays an installer's applies of the agent Deployment, in call order. */
    public Replay(kubectl: IRecordedApplies, deployment: string): this
    {
        let server = 0
        let client = 0
        for (const [verb] of kubectl.Calls)
        {
            if (verb === 'ApplyServerSide') this.Apply(kubectl.ServerApplied[server++]!, deployment, names => this.ServerSide(names))
            if (verb === 'Apply') this.Apply(kubectl.Applied[client++]!, deployment, names => this.ClientSide(names))
        }
        return this
    }

    private Apply(manifest: string, deployment: string, apply: (names: string[]) => void): void
    {
        const items = (JSON.parse(manifest) as { items?: Obj[] }).items ?? []
        const agent = items.find(i => i.kind === 'Deployment' && i.metadata?.name === deployment)
        if (agent === undefined) return
        apply(((agent.spec.template.spec.containers as Obj[]).find(c => c.name === 'agent')?.env ?? []).map((e: Obj) => e.name as string))
    }

    private Owners(name: string): Set<string>
    {
        let owners = this.owners.get(name)
        if (owners === undefined)
        {
            owners = new Set()
            this.owners.set(name, owners)
        }
        return owners
    }
}
