// Small presentational primitives. Deliberately not a component library — just enough to keep
// Tailwind class soup out of the page files.

import type { ChangeEvent, ReactNode } from 'react'

type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-blue-600 text-white hover:bg-blue-500 border border-blue-500',
  outline: 'bg-ink-800 text-slate-200 hover:bg-ink-700 border border-ink-600',
  ghost: 'bg-transparent text-slate-400 hover:text-slate-100 hover:bg-ink-800 border border-transparent',
  danger: 'bg-transparent text-red-300 hover:bg-red-500/10 border border-red-500/40',
}

export function Button({
  children,
  onClick,
  variant = 'outline',
  disabled,
  title,
  type = 'button',
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: ButtonVariant
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
  className?: string
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-slate-500">{hint}</span>}
    </label>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  maxLength,
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  maxLength?: number
  ariaLabel?: string
}) {
  return (
    <input
      value={value}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      placeholder={placeholder}
      maxLength={maxLength}
      aria-label={ariaLabel}
      className="w-full rounded-lg border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
    />
  )
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T
  onChange: (value: T) => void
  options: readonly { value: T; label: string }[]
  ariaLabel?: string
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as T)}
      aria-label={ariaLabel}
      className="w-full rounded-lg border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-sm text-slate-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step,
  format,
  ariaLabel,
}: {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step: number
  format?: (value: number) => string
  ariaLabel?: string
}) {
  return (
    <div className="flex items-center gap-2.5">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel}
        onChange={e => onChange(Number(e.target.value))}
        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-ink-700 accent-blue-500"
      />
      <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-400">
        {format ? format(value) : value}
      </span>
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-300">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
          checked ? 'bg-blue-600' : 'bg-ink-600'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-[18px]' : 'translate-x-0.5'
          }`}
        />
      </button>
      {label}
    </label>
  )
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (value: T) => void
  options: readonly { value: T; label: string }[]
}) {
  return (
    <div className="flex gap-1 rounded-lg border border-ink-600 bg-ink-900 p-1">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
            value === o.value ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-ink-800 hover:text-slate-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Banner({
  tone,
  children,
}: {
  tone: 'info' | 'warn' | 'error' | 'success'
  children: ReactNode
}) {
  const tones = {
    info: 'border-blue-500/40 bg-blue-500/10 text-blue-200',
    warn: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
    error: 'border-red-500/40 bg-red-500/10 text-red-200',
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  }
  return <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${tones[tone]}`}>{children}</div>
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-500">{children}</h2>
}
