import { ServiceKey, type IServiceProvider } from '@pragmatic-tech-ai/mural/runtime'
import { PortalSectionService } from '../../shell/portal-section-service.js'
import type { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import { HostCodeRevealPageViewModel } from './host-code-reveal-page-view-model.js'
import { HostsPageViewModel } from './hosts-page-view-model.js'

// The Hosts rail section: the machines that host Hosted hives (their host
// agents), and the one-time host code an operator issues to enrol a new one.
export class HostsSectionService extends PortalSectionService
{
    public static readonly Key = new ServiceKey<HostsSectionService>('HostsSectionService')

    public constructor(provider: IServiceProvider)
    {
        super(provider)
    }

    // Shows a freshly issued host code once.
    public RevealCode(code: string, expiresAt: string): void
    {
        this.Present(new HostCodeRevealPageViewModel(this, code, expiresAt))
    }

    protected override CreateRoot(): PortalPageViewModel
    {
        return new HostsPageViewModel(this.Session, this)
    }
}
