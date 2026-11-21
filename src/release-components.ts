import { ContainerComponentSource, ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { PlatformAdminComponent } from './platform-admin-component.js'

/**
 * This repository's one component, as `pragmatic-component-descriptors --components dist/release-components.js` reads it
 * (the image's component stage and the release workflow's component.json asset).
 */
export const Components = new ContainerComponentSource(ReleaseApp.PlatformAdmin, () => PlatformAdminComponent.Descriptor())
