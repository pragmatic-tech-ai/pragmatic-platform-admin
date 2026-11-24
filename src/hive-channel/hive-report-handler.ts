import { AgentExchangeRefusal, HiveReport, MessageKind, type IBodyDecoder, type VerifiedMessage } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { PlatformHiveRecords, type PlatformHiveRecord } from '../platform-records.js'
import type { AgentAnswer, IAgentMessageHandler } from './platform-agent-exchange.js'
import { AgentExchangeRefusedError } from './platform-agent-exchange.js'

/** Where a verified report is kept (HiveObservationRegistry). */
export interface IHiveReportSink
{
    RecordReport(hiveId: string, report: HiveReport): Promise<void>
}

/** Where the reporting hive's record is read. */
export interface IReportingHives
{
    GetHive(id: string): PlatformHiveRecord | undefined
}

/**
 * A hive's signed HiveReport (C3.3): verified against the hive's registered key, then kept as its latest observation
 * (last seen, component states, environments, intent progress). Every member is a closed shape, so a report cannot
 * carry free text. A report from a hive its customer left is refused `hive-gone`. Acknowledged with no answer (204).
 */
export class HiveReportHandler implements IAgentMessageHandler<HiveReport>
{
    public readonly Kind = MessageKind.HiveReport
    public readonly Decoder: IBodyDecoder<HiveReport> = HiveReport

    public constructor(private readonly hives: IReportingHives, private readonly reports: IHiveReportSink)
    {
    }

    public async Handle(message: VerifiedMessage<HiveReport>): Promise<AgentAnswer | null>
    {
        const hive = this.hives.GetHive(message.Issuer.Id)
        if (hive === undefined || PlatformHiveRecords.HasLeft(hive))
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.HiveGone)
        }
        await this.reports.RecordReport(hive.id, message.Body)
        return null
    }
}
