/** A client's section did not start within the wait limit (another section of the client holds it too long). */
export class ClientLockTimeoutError extends Error
{
    private static readonly ErrorName = 'ClientLockTimeoutError'
    private static readonly MessagePrefix = 'Timed out waiting for the client lock: '

    public constructor(clientId: string)
    {
        super(ClientLockTimeoutError.MessagePrefix + clientId)
        this.name = ClientLockTimeoutError.ErrorName
    }
}

/**
 * Serialises the gated operations of one client in this process: the entitlement decision and the write it allows run
 * as one section, so two concurrent creates at `tenants: 1` cannot both see a usage of 0. The console is one process
 * whose registries are in-memory record stores over write-behind SQL, so an in-process queue is the whole guard (a
 * database lock would protect nothing the cache does not already). Different clients never wait on each other. A
 * section waits at most `waitMs` for the sections queued before it; past that it gives up (ClientLockTimeoutError, the
 * customer API's `unavailable`) without running, so a caller is never held past its edge's deadline. Sections are meant
 * to be short: a decision and its record writes, never provisioning work.
 */
export class ClientLock
{
    public static readonly DefaultWaitMs = 4000

    private readonly queues = new Map<string, Promise<unknown>>()

    public constructor(private readonly waitMs: number = ClientLock.DefaultWaitMs)
    {
    }

    public Run<T>(clientId: string, work: () => Promise<T>): Promise<T>
    {
        const previous = this.queues.get(clientId) ?? Promise.resolve()
        const queuedAt = Date.now()
        const guarded = async (): Promise<T> =>
        {
            if (Date.now() - queuedAt > this.waitMs)
            {
                throw new ClientLockTimeoutError(clientId)
            }
            return await work()
        }
        const next = previous.then(guarded, guarded)
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
