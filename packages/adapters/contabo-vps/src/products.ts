/**
 * Contabo product ids and what the OFFICIAL documentation states about them.
 * Sources (read 2026-11-18): product ids/names/disk: https://api.contabo.com/ (CreateInstanceRequest `productId` table);
 * VDS cores/RAM/bandwidth: https://docs.contabo.com/docs/servers-hosting/max-performance-vps/ ; snapshot availability per family:
 * https://docs.contabo.com/docs/servers-hosting/vps/ and .../max-performance-vps/.
 * NOT documented anywhere we could read: a product-list endpoint, prices, region availability per product, exact vCPU/RAM per Cloud VPS /
 * Cloud VPS Plus / Storage VPS plan (only ranges). Those plans therefore have NO complete spec here and are never listed as plans.
 */
export type ProductFamily = 'cloud-vps' | 'cloud-vps-plus' | 'storage-vps' | 'vds';
export interface ContaboProduct {
  productId: string;
  name: string;
  family: ProductFamily;
  diskGb: number;
  diskType: 'SSD' | 'NVMe';
  /** Present only when the docs give an exact value. */
  vcpu?: number;
  memoryGb?: number;
  bandwidthMbit?: number;
}

const P = (
  productId: string,
  name: string,
  family: ProductFamily,
  diskGb: number,
  diskType: 'SSD' | 'NVMe',
  extra: Partial<ContaboProduct> = {},
): ContaboProduct => ({ productId, name, family, diskGb, diskType, ...extra });

export const CONTABO_PRODUCTS: readonly ContaboProduct[] = [
  P('V153', 'Cloud VPS 4', 'cloud-vps', 100, 'SSD'),
  P('V154', 'Cloud VPS 6', 'cloud-vps', 200, 'SSD'),
  P('V155', 'Cloud VPS 8', 'cloud-vps', 300, 'SSD'),
  P('V156', 'Cloud VPS 12', 'cloud-vps', 400, 'SSD'),
  P('V157', 'Cloud VPS 16', 'cloud-vps', 500, 'SSD'),
  P('V158', 'Cloud VPS 18', 'cloud-vps', 600, 'SSD'),
  P('V159', 'Cloud VPS Plus 4', 'cloud-vps-plus', 150, 'NVMe'),
  P('V160', 'Cloud VPS Plus 6', 'cloud-vps-plus', 300, 'NVMe'),
  P('V161', 'Cloud VPS Plus 8', 'cloud-vps-plus', 450, 'NVMe'),
  P('V162', 'Cloud VPS Plus 12', 'cloud-vps-plus', 600, 'NVMe'),
  P('V163', 'Cloud VPS Plus 16', 'cloud-vps-plus', 750, 'NVMe'),
  P('V164', 'Cloud VPS Plus 18', 'cloud-vps-plus', 900, 'NVMe'),
  P('V93', 'VPS 10 Storage', 'storage-vps', 300, 'SSD'),
  P('V96', 'VPS 20 Storage', 'storage-vps', 400, 'SSD'),
  P('V99', 'VPS 30 Storage', 'storage-vps', 1000, 'SSD'),
  P('V102', 'VPS 40 Storage', 'storage-vps', 1200, 'SSD'),
  P('V105', 'VPS 50 Storage', 'storage-vps', 1400, 'SSD'),
  P('V8', 'VDS S', 'vds', 180, 'NVMe', { vcpu: 6, memoryGb: 24, bandwidthMbit: 250 }),
  P('V9', 'VDS M', 'vds', 240, 'NVMe', { vcpu: 8, memoryGb: 32, bandwidthMbit: 500 }),
  P('V10', 'VDS L', 'vds', 360, 'NVMe', { vcpu: 12, memoryGb: 48, bandwidthMbit: 750 }),
  P('V11', 'VDS XL', 'vds', 480, 'NVMe', { vcpu: 16, memoryGb: 64, bandwidthMbit: 1000 }),
  P('V16', 'VDS XXL', 'vds', 720, 'NVMe', { vcpu: 24, memoryGb: 96, bandwidthMbit: 1000 }),
];

export const productById = (id: string): ContaboProduct | undefined =>
  CONTABO_PRODUCTS.find((p) => p.productId === id);

/** docs.contabo.com: snapshots — Cloud VPS 1-3 (by plan), Cloud VPS Plus 5, Storage VPS none, VDS not available. */
export const snapshotsDocumented = (productId: string): boolean => {
  const f = productById(productId)?.family;
  return f === 'cloud-vps' || f === 'cloud-vps-plus';
};

/** CreateInstanceRequest `region` enum (https://api.contabo.com/, read 2026-11-18) and the country each region name denotes in the docs. */
export const CONTABO_REGION_ENUM = [
  'EU',
  'US-central',
  'US-east',
  'US-west',
  'SIN',
  'UK',
  'AUS',
  'JPN',
  'IND',
] as const;
/**
 * Country per region slug. The docs name regions ("European Union", "United Kingdom", USA, Singapore, Japan, India, Australia) — an EU
 * region has NO single documented country, so it maps to the ISO 3166-1 exceptional reservation `EU` (open item SI-M05-7: the owner / a
 * live probe must confirm the data-centre country before any residency decision relies on it).
 */
export const CONTABO_REGION_COUNTRY: Record<string, string> = {
  EU: 'EU',
  UK: 'GB',
  'US-central': 'US',
  'US-east': 'US',
  'US-west': 'US',
  SIN: 'SG',
  AUS: 'AU',
  JPN: 'JP',
  IND: 'IN',
};
