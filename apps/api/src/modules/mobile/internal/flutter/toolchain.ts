/**
 * Pinned Flutter toolchain of the template set (M10 S48.1: "pinned toolchain version recorded in report"). The values are what was installed and run when the template was
 * analysed and tested locally (docs/reports/S48-report.md); a build worker records the toolchain it actually used in `mobile.builds.toolchain` and refuses a different one.
 */
export const TEMPLATE_SET_ID = 'nuzm-flutter-core';
export const TEMPLATE_SET_VERSION = '1.0.0';
export const PINNED_TOOLCHAIN = {
  flutter: '3.35.7',
  dart: '3.9.2',
  /** Dart SDK constraint written into every generated pubspec */
  sdkConstraint: '>=3.9.0 <4.0.0',
  templateSet: `${TEMPLATE_SET_ID}@${TEMPLATE_SET_VERSION}`,
} as const;
export type PinnedToolchain = typeof PINNED_TOOLCHAIN;
