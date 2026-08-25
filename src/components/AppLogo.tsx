// The app mark.
//
// Points at /logo-192.png rather than the 739 KB source in public/brand/: rendering a 48px logo
// does not need a 1254px bitmap, and 192px still covers a 4x display. Both come from the same
// artwork via tools/make-icons.ps1.

export interface AppLogoProps {
  /** Rendered size in CSS px. The mark is square-padded, so this is both width and height. */
  size?: number
  className?: string
}

export default function AppLogo({ size = 40, className = '' }: AppLogoProps) {
  return (
    <img
      src="/logo-192.png"
      width={size}
      height={size}
      // Decorative wherever it appears: every placement sits beside the app name or a labelled
      // link, so announcing it again would just be noise for a screen reader.
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`shrink-0 select-none ${className}`}
      style={{ width: size, height: size }}
    />
  )
}
