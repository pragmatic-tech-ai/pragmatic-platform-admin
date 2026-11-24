// HostsModule - the Hosts section as a ShellModule. One capability (rail
// entry) backed by HostsSectionService, which presents the host list and a
// freshly issued host code in the shell's content region; the section's
// views merge in from HostsResources.

import HostsSectionService from "./hosts-section-service.js"
import HostsResources from "./hosts.resources.mu.js"

shell module HostsModule [ Name = "Hosts" ] {
    .services: {
        HostsSectionService
    }

    Capability [ Name = "Hosts", Icon = @HostsIcon, ServiceKey = HostsSectionService ]

    resources: {
        merge HostsResources
    }
}
