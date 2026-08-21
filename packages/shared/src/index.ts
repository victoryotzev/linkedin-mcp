export { ulid, newId, isId, type IdPrefix } from './ids.ts';
export { canonicalJson, type Jsonish } from './canonical.ts';
export { DomainError, type ErrorCode } from './errors.ts';
export { resolveDataHome, type DataHomeEnvironment } from './dataHome.ts';

export const RETENTION_CLASSES = [
  'durable_user',
  'durable_dma',
  'marketing_48h',
  'derived',
] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export const CAPABILITY_FEATURES = [
  'linkedin.oidc_userinfo',
  'linkedin.dma_snapshot',
  'linkedin.dma_changelog',
  'linkedin.publish_post',
  'linkedin.image_upload',
] as const;
export type CapabilityFeature = (typeof CAPABILITY_FEATURES)[number];
