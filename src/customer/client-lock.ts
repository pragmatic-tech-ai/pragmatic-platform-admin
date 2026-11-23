/**
 * Serialises the gated operations of one client in this process: the entitlement decision and the write it allows run
 * as one section, so two concurrent creates at `tenants: 1` cannot both see a usage of 0. The console is one process
 * whose registries are in-memory record stores over write-behind SQL, so an in-process queue is the whole guard (a
 * database lock would protect nothing the cache does not already). Different clients never wait on each other.
 */
export class ClientLock
{
    private readonly queues = new Map<string, Promise<unknown>>()

    public Run<T>(clientId: string, work: () => Promise<T>): Promise<T>
    {
        const previous = this.queues.get(clientId) ?? Promise.resolve()
        const next = previous.then(work, work)
        const tail = next.catch(() => undefined)
        this.queues.set(clientId, tail)
        void tail.then(() =>
        {
            if (this.queues.get(clientId) === tail)
            {
                this.queues.delete(clientId)
            }
        })
        return next
    }
}
