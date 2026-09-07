/**
 * Every glyph in the Forge design spec, transcribed path-for-path.
 *
 * The design draws its icons inline as SVG rather than pulling a font, so the
 * stroke widths and viewBoxes here are the spec's own numbers — changing one
 * changes how the icon sits against the text beside it.
 */

interface IconProps {
  size?: number
  color?: string
  style?: React.CSSProperties
}

const S = (n: number) => ({ width: n, height: n })

export function ChatIcon({ size = 13 }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4}>
      <path d="M2.5 4.2A1.7 1.7 0 0 1 4.2 2.5h7.6A1.7 1.7 0 0 1 13.5 4.2v4.6a1.7 1.7 0 0 1-1.7 1.7H7l-3.2 2.6v-2.6a1.3 1.3 0 0 1-1.3-1.3Z" />
    </svg>
  )
}

export function TerminalIcon({ size = 13 }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4}>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M4.8 7 6.6 8.6 4.8 10.2M8.4 10.4h2.8" />
    </svg>
  )
}

export function SplitIcon({ size = 13 }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4}>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M8 3v10" />
    </svg>
  )
}

/** Split the focused pane to the right. */
export function SplitRightIcon({ size = 14 }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M8 2.5v11" />
    </svg>
  )
}

/** Split the focused pane downward. */
export function SplitDownIcon({ size = 14 }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M1.5 8h13" />
    </svg>
  )
}

export function ProjectIcon({ size = 14, color = '#A1A19A' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4}>
      <path d="M3 4h10M5 8h6M7 12h2" />
    </svg>
  )
}

/** Open repository — folder with a plus mark. */
export function FolderPlusIcon({ size = 14, color = 'currentColor' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4}>
      <path d="M2.5 5.2A1.2 1.2 0 0 1 3.7 4h3.2l1.4 1.6h4.2a1.2 1.2 0 0 1 1.2 1.2v5.4a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2Z" />
      <path d="M8 7.2v3.2M6.4 8.8h3.2" />
    </svg>
  )
}

export function BranchIcon({ size = 13, color = '#A1A19A' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4}>
      <circle cx="4.5" cy="3.5" r="1.8" />
      <circle cx="4.5" cy="12.5" r="1.8" />
      <circle cx="11.5" cy="6" r="1.8" />
      <path d="M4.5 5.3v5.4M6.3 6h1.4c1.2 0 2 .8 2 2v1.5" />
    </svg>
  )
}

export function ChevronDown({ size = 10, color = '#A1A19A' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth={1.5}>
      <path d="M2 4.5 6 8.5l4-4" />
    </svg>
  )
}

export function ChevronRight({ size = 12, color = 'currentColor' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth={1.5}>
      <path d="M5 2.5 9.5 7 5 11.5" />
    </svg>
  )
}

export function ChevronUp({ size = 13, color = '#A1A19A', style }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth={1.5} style={style}>
      <path d="M2.5 8.5 7 4l4.5 4.5" />
    </svg>
  )
}

/** Panel collapse chevrons — heavier stroke than the disclosure ones. */
export function CaretLeft({ size = 14, color = 'currentColor' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth={1.6}>
      <path d="M8.5 2.5 4 7l4.5 4.5" />
    </svg>
  )
}

export function CaretRight({ size = 14, color = 'currentColor' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth={1.6}>
      <path d="M5.5 2.5 10 7l-4.5 4.5" />
    </svg>
  )
}

export function SearchIcon({ size = 13 }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx="6.8" cy="6.8" r="4.3" />
      <path d="M10 10l3.2 3.2" />
    </svg>
  )
}

export function BellIcon({ size = 17, color = '#A1A19A' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 18 18" fill="none" stroke={color} strokeWidth={1.4}>
      <path d="M9 2.5a4 4 0 0 0-4 4v3l-1.3 2.2h10.6L13 9.5v-3a4 4 0 0 0-4-4Z" />
      <path d="M7.3 14a1.8 1.8 0 0 0 3.4 0" />
    </svg>
  )
}

/** Settings — the Lucide gear, transcribed path-for-path. */
export function SettingsIcon({ size = 14, color = 'currentColor' }: IconProps) {
  return (
    <svg
      {...S(size)}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function ToolIcon({ size = 13, color = '#A1A19A' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.3}>
      <rect x="2" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9.5" y="9" width="4.5" height="4.5" rx="1" />
      <path d="M4.2 7v3.2h5.3" />
    </svg>
  )
}

export function CheckIcon({ size = 13, color = '#87C9AE', style }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth={1.7} style={style}>
      <path d="M2.5 7.5 5.5 10.5 11.5 4" />
    </svg>
  )
}

/** The running arc. Spins via the `bfspin` keyframes so reduced-motion can park it. */
export function Spinner({ size = 13, color = '#E3F86C', style }: IconProps) {
  return (
    <svg
      {...S(size)}
      viewBox="0 0 14 14"
      fill="none"
      stroke={color}
      strokeWidth={1.7}
      style={{ animation: 'bfspin 1.1s linear infinite', ...style }}
    >
      <path d="M7 1.6a5.4 5.4 0 1 1-5.3 6.4" />
    </svg>
  )
}

export function CircleIcon({ size = 13, color = 'currentColor' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth={1.3}>
      <circle cx="7" cy="7" r="5.3" />
    </svg>
  )
}

export function PlayIcon({ size = 9 }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 10 10" fill="currentColor">
      <path d="M3 2l5 3-5 3Z" />
    </svg>
  )
}

export function StopIcon({ size = 9, color = '#fff' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 10 10" fill={color}>
      <rect x="2.6" y="2.6" width="4.8" height="4.8" rx="1" />
    </svg>
  )
}

export function SendIcon({ size = 15 }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.7}>
      <path d="M4 12.5 11.5 8 4 3.5" />
    </svg>
  )
}

/** Completed vs pending, as a filled circle — the reference status chip. */
export function StatusMark({ done = false, size = 22 }: { done?: boolean; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: done ? '#D6F23A' : '#2A2A28',
        display: 'grid',
        placeItems: 'center',
        flex: 'none'
      }}
    >
      {done ? <CheckIcon size={Math.round(size * 0.5)} color="#1B1D13" /> : null}
    </span>
  )
}

export function ClipIcon({ size = 17, color = '#A1A19A' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 18 18" fill="none" stroke={color} strokeWidth={1.3}>
      <path d="M11.5 5.5 6.8 10.2a2.3 2.3 0 0 0 3.2 3.2l5-5a4 4 0 0 0-5.6-5.6L4 7.2a5.6 5.6 0 0 0 8 8" />
    </svg>
  )
}

/** Copy a message from the assistant footer. */
export function CopyIcon({ size = 15, color = '#A1A19A' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.3} style={{ cursor: 'pointer' }}>
      <rect x="2.5" y="2.5" width="8" height="8" rx="1.5" />
      <path d="M5.5 13.5h6a2 2 0 0 0 2-2v-6" />
    </svg>
  )
}

/** Clear the branch chat — bubble with a minus, not “add another chat”. */
export function ClearChatIcon({ size = 14, color = '#A1A19A' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4}>
      <path d="M2.5 4.2A1.7 1.7 0 0 1 4.2 2.5h7.6A1.7 1.7 0 0 1 13.5 4.2v4.6a1.7 1.7 0 0 1-1.7 1.7H7l-3.2 2.6v-2.6a1.3 1.3 0 0 1-1.3-1.3Z" />
      <path d="M5.5 8h5" />
    </svg>
  )
}

export function PinIcon({ size = 14, color = 'currentColor' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4}>
      <path d="M9.8 2.4 13.6 6.2c.35.35.28 1-.16 1.24L11 8.6 8.7 13.2 2.8 7.3 7.4 5l1.16-2.44c.24-.44.89-.51 1.24-.16Z" />
      <path d="m6.6 9.4-3.4 3.4" />
    </svg>
  )
}

/** Source control — branch node with a commit dot. */
export function GitIcon({ size = 13, color = 'currentColor' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4}>
      <circle cx="5" cy="4" r="1.6" fill={color} stroke="none" />
      <circle cx="5" cy="12" r="1.6" fill={color} stroke="none" />
      <circle cx="11" cy="8" r="1.6" fill={color} stroke="none" />
      <path d="M5 5.6v4.8M5 4v0M5 12v0M7.2 8h2.2" />
    </svg>
  )
}
