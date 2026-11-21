import { EnvironmentWorkloadFactory, ReleaseState, type ManifestRecord, type ManifestRegistry } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ReleaseRegistry, ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

/** Where the platform's own images (the hive agent, the console's tenant-admin and IdP) come from. */
export interface IPlatformImages
{
    /** The image to run for the app; undefined when there is none to offer yet. */
    ImageOf(app: ReleaseApp): string | undefined
}

/** The copy every install path refuses with while no verified, non-withdrawn platform release exists. */
export class PlatformImages
{
    public static readonly NoReleaseMessage = 'no verified platform release yet'

    private constructor()
    {
    }
}

/**
 * A development box: each platform app runs its own locally built image, `<app>:dev`, built from that app's container
 * repository by pragmatic-e2e's dev image builder (`src/dev/dev-images.ts`). The env server's is the one the tenant plane
 * renders for every environment workload (EnvironmentWorkloadFactory.ServerImage, `pragmatic-env-server:dev`), so this
 * map and what an environment runs cannot disagree; Postgres keeps `pragmatic-postgres:local`.
 */
export class DevPlatformImages implements IPlatformImages
{
    /** The env server's dev image: the tenant plane's EnvironmentWorkloadFactory names it for every environment. */
    public static readonly EnvServerImage = EnvironmentWorkloadFactory.ServerImage
    /** The locally built pragmatic-postgres (its repository's bake, tagged by pragmatic-e2e's dev image builder). */
    public static readonly PostgresImage = 'pragmatic-postgres:local'
    private static readonly DevTagSuffix = ':dev'

    public ImageOf(app: ReleaseApp): string
    {
        return DevPlatformImages.Of(app)
    }

    /** The dev image of `app` (see the class comment). */
    public static Of(app: ReleaseApp): string
    {
        switch (app)
        {
            case ReleaseApp.EnvServer:
                return DevPlatformImages.EnvServerImage
            case ReleaseApp.Postgres:
                return DevPlatformImages.PostgresImage
            default:
                return app + DevPlatformImages.DevTagSuffix
        }
    }
}

/**
 * The newest verified, non-withdrawn release in the manifest catalogue (by publishedAt), named by digest under the registry
 * host the catalogue was read from. Locally published and rejected records are never offered.
 */
export class ReleasePlatformImages implements IPlatformImages
{
    public constructor(private readonly manifests: ManifestRegistry, private readonly imageHost: string)
    {
    }

    public ImageOf(app: ReleaseApp): string | undefined
    {
        const image = this.NewestWith(app)?.release?.images?.[app]
        return image === undefined ? undefined : ReleaseRegistry.DigestReference(this.imageHost, image.repository, image.digest)
    }

    /** The newest verified, non-withdrawn record that carries an image for the app (a release may predate an app). */
    private NewestWith(app: ReleaseApp): ManifestRecord | undefined
    {
        let newest: ManifestRecord | undefined
        for (const record of this.manifests.List())
        {
            if (record.release?.state !== ReleaseState.Verified || record.withdrawn === true || record.release.images?.[app] === undefined)
            {
                continue
            }
            if (newest === undefined || Date.parse(record.publishedAt) > Date.parse(newest.publishedAt))
            {
                newest = record
            }
        }
        return newest
    }
}
