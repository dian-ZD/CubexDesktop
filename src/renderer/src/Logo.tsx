import logoUrl from './assets/logo.png'

interface LogoProps {
  size?: number
  className?: string
  title?: string
  rounded?: boolean
}

export function Logo({ size = 24, className, title = 'Cubex', rounded = false }: LogoProps) {
  const img = (
    <img
      className={rounded ? undefined : className}
      src={logoUrl}
      width={rounded ? Math.round(size * 0.88) : size}
      height={rounded ? Math.round(size * 0.88) : size}
      alt={title}
      title={title}
      draggable={false}
      style={{ objectFit: 'contain' }}
    />
  )
  if (!rounded) return img
  return (
    <span
      className={className ? `logo-rounded ${className}` : 'logo-rounded'}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
    >
      {img}
    </span>
  )
}
