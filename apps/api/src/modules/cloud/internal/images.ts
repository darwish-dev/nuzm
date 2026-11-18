import type { Db } from '@nuzm/platform';
import { UUID, type Row } from './common';

/** `compute.images`: the image catalogue per provider account/region, written by catalog syncs (admin scope) and read by quotes and the wizard. */
export class ImageCatalog {
  constructor(private readonly db: Db) {}

  async findImage(
    imageId: string,
    accountId: string,
    providerRegionId: string,
  ): Promise<{ id: string; imageRef: string; name: string } | null> {
    if (!UUID.test(imageId)) return null;
    const r = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, image_ref, name FROM compute.images WHERE id = $1 AND account_id = $2 AND provider_region_id = $3`,
            [imageId, accountId, providerRegionId],
          )
        ).rows[0] as Row | undefined,
    );
    return r
      ? { id: r.id as string, imageRef: r.image_ref as string, name: r.name as string }
      : null;
  }

  /** Images offered for one offer's account and region (customer-safe: id, name, osFamily). */
  async forOffer(accountId: string, providerRegionId: string) {
    return this.db.withPlatformScope(async (c) =>
      (
        await c.query(
          `SELECT id, name, os_family FROM compute.images WHERE account_id = $1 AND provider_region_id = $2 ORDER BY name`,
          [accountId, providerRegionId],
        )
      ).rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        osFamily: (r.os_family as string | null) ?? null,
      })),
    );
  }
}
