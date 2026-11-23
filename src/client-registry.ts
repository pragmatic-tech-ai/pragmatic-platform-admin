import { JsonRecordStore, type IRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ClientRecords, type ClientRecord } from './platform-records.js'

/** The client records; every read is rebuilt from the named fields (ClientRecords.Of), so a legacy row's extra fields
 *  (a pre-D4 `subscriptionRef`) are never answered and are dropped at the record's next write. */
export class ClientRegistry extends JsonRecordStore<ClientRecord>
{
    public static readonly RootKey = 'clients'

    public constructor(location: string | IRecordMap<ClientRecord>)
    {
        super(location, ClientRegistry.RootKey)
    }

    public override List(): readonly ClientRecord[]
    {
        return super.List().map(record => ClientRecords.Of(record))
    }

    public override Get(id: string): ClientRecord | undefined
    {
        const record = super.Get(id)
        return record === undefined ? undefined : ClientRecords.Of(record)
    }

    public override async Put(record: ClientRecord): Promise<void>
    {
        await super.Put(ClientRecords.Of(record))
    }
}
