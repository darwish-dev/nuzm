/**
 * The Nuzm logo (the owner's artwork, cut out as transparent PNGs in /public/brand). The cream logo is drawn as-is on the dark theme and
 * darkened by CSS on the light theme; the same Latin lettering is used in Arabic and English. Decorative inside a labelled link.
 */
export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <img
      className={`nzc-logo ${className}`}
      src="/brand/nuzm-mark.png?v=mint1"
      width={33}
      height={26}
      alt=""
    />
  );
}
export function BrandWordmark({ className = '' }: { className?: string }) {
  return (
    <img
      className={`nzc-logo ${className}`}
      src="/brand/nuzm-logo.png?v=mint1"
      width={115}
      height={26}
      alt=""
    />
  );
}

/** Top-of-page logo for the sign-in and registration pages. */
export function AuthLogo({ href }: { href: string }) {
  return (
    <a className="nzc-auth-logo" href={href} aria-label="Nuzm">
      <BrandWordmark />
    </a>
  );
}
