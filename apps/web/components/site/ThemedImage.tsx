/**
 * An illustration in both looks: the light original and its dark-mode version (`/images/illustrations/dark/...`). The page's theme (`data-mode` on the
 * `.landing` wrapper) shows one and hides the other in CSS (mosaic.css), so a theme switch needs no script and no reload. Hidden images are lazy, so the
 * browser fetches only the one in use.
 */
export function ThemedImage({
  src,
  width,
  height,
  className,
  eager = false,
}: {
  /** the light file, `/images/illustrations/<name>.<ext>` */
  src: string;
  width: number;
  height: number;
  className?: string;
  eager?: boolean;
}) {
  const dark = src.replace('/images/illustrations/', '/images/illustrations/dark/');
  const loading = eager ? 'eager' : 'lazy';
  return (
    <>
      <img
        className={`il-light ${className ?? ''}`.trim()}
        src={src}
        alt=""
        width={width}
        height={height}
        loading={loading}
      />
      <img
        className={`il-dark ${className ?? ''}`.trim()}
        src={dark}
        alt=""
        width={width}
        height={height}
        loading={loading}
      />
    </>
  );
}
