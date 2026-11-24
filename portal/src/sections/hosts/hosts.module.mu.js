import { HostsSectionService } from "./hosts-section-service.js";
import { HostsResources } from "./hosts.resources.mu.js";
import { Capability, ShellModule } from "@pragmatic-tech-ai/mural/framework/shell/module.js";
import { DynamicResource, ServiceProvider } from "@pragmatic-tech-ai/mural/runtime";

export const HostsModule = (() => {
    const _shellModule0 = new ShellModule();
    _shellModule0.set_property_value(ShellModule.NameKey, "Hosts");
    _shellModule0.AddRegistration(ServiceProvider.tokenFor(HostsSectionService), (p) => new HostsSectionService(p), 'singleton');
    const _capability1 = new Capability();
    _capability1.set_property_value(Capability.NameKey, "Hosts");
    _capability1.set_property_value(Capability.IconKey, DynamicResource(_capability1, "HostsIcon"));
    _capability1.set_property_value(Capability.ServiceKeyKey, HostsSectionService);
    _shellModule0.AddChild(_capability1);
    const _rd2 = _shellModule0.Resources;
    for (const [_k, _v] of HostsResources.Clone().Entries()) _rd2.Set(_k, _v);
    return _shellModule0;
})();
