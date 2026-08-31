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

export function ProjectIcon({ size = 14, color = '#94A3B8' }: IconProps) {
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

export function BranchIcon({ size = 13, color = '#94A3B8' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4}>
      <circle cx="4.5" cy="3.5" r="1.8" />
      <circle cx="4.5" cy="12.5" r="1.8" />
      <circle cx="11.5" cy="6" r="1.8" />
      <path d="M4.5 5.3v5.4M6.3 6h1.4c1.2 0 2 .8 2 2v1.5" />
    </svg>
  )
}

export function ChevronDown({ size = 10, color = '#94A3B8' }: IconProps) {
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

export function ChevronUp({ size = 13, color = '#94A3B8', style }: IconProps) {
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

export function BellIcon({ size = 17, color = '#94A3B8' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 18 18" fill="none" stroke={color} strokeWidth={1.4}>
      <path d="M9 2.5a4 4 0 0 0-4 4v3l-1.3 2.2h10.6L13 9.5v-3a4 4 0 0 0-4-4Z" />
      <path d="M7.3 14a1.8 1.8 0 0 0 3.4 0" />
    </svg>
  )
}

export function GearIcon({ size = 17, color = '#94A3B8' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 18 18" fill="none" stroke={color} strokeWidth={1.4}>
      <path d="M7.2 1.8h3.6l.4 1.5a5.6 5.6 0 0 1 1.3.8l1.5-.5 1.8 1.8-.5 1.5c.3.4.6.8.8 1.3l1.5.4v3.6l-1.5.4a5.6 5.6 0 0 1-.8 1.3l.5 1.5-1.8 1.8-1.5-.5a5.6 5.6 0 0 1-1.3.8l-.4 1.5H7.2l-.4-1.5a5.6 5.6 0 0 1-1.3-.8l-1.5.5-1.8-1.8.5-1.5a5.6 5.6 0 0 1-.8-1.3L1.4 10.8V7.2l1.5-.4c.2-.5.5-.9.8-1.3l-.5-1.5 1.8-1.8 1.5.5c.4-.3.8-.6 1.3-.8Z" />
      <circle cx="9" cy="9" r="2.2" />
    </svg>
  )
}

/** The agent's mark — an eight-point sparkle, in AI violet. */
export function Sparkle({ size = 15, color = '#bf5af2', width = 1.2 }: IconProps & { width?: number }) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={width}>
      <path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" />
    </svg>
  )
}

/** The larger greeting mark: same star, drawn edge-to-edge with a finer stroke. */
export function SparkleLarge({ size = 30, color = '#bf5af2' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.15}>
      <path d="M8 1v14M1 8h14M3.05 3.05l9.9 9.9M12.95 3.05l-9.9 9.9" />
    </svg>
  )
}

export function ToolIcon({ size = 13, color = '#94A3B8' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.3}>
      <rect x="2" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9.5" y="9" width="4.5" height="4.5" rx="1" />
      <path d="M4.2 7v3.2h5.3" />
    </svg>
  )
}

export function CheckIcon({ size = 13, color = '#22C55E', style }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth={1.7} style={style}>
      <path d="M2.5 7.5 5.5 10.5 11.5 4" />
    </svg>
  )
}

/** The running arc. Spins via the `bfspin` keyframes so reduced-motion can park it. */
export function Spinner({ size = 13, color = '#60A5FA', style }: IconProps) {
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

export function ErrorIcon({ size = 13, color = 'currentColor' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth={1.3}>
      <circle cx="7" cy="7" r="5.3" />
      <path d="M7 4v3.4M7 9.6v.1" />
    </svg>
  )
}

export function WarnIcon({ size = 13, color = 'currentColor' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth={1.3}>
      <path d="M7 2 12.5 12H1.5Z" />
      <path d="M7 6v2.4" />
    </svg>
  )
}

export function PlayIcon({ size = 9 }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 10 10" fill="#fff">
      <path d="M3 2l5 3-5 3Z" />
    </svg>
  )
}

export function StopIcon({ size = 9 }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 10 10" fill="#fff">
      <rect x="2.6" y="2.6" width="4.8" height="4.8" rx="1" />
    </svg>
  )
}

export function SendIcon({ size = 15 }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth={1.7}>
      <path d="M4 12.5 11.5 8 4 3.5" />
    </svg>
  )
}

/** Composer: the model indicator — an aperture ring. */
export function ModelIcon({ size = 17, color = '#94A3B8' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 18 18" fill="none" stroke={color} strokeWidth={1.3}>
      <circle cx="9" cy="9" r="7.2" />
      <path d="M11.8 6.4v4.2a2 2 0 0 0 2.4 1.9" />
      <circle cx="9" cy="9" r="2.4" />
    </svg>
  )
}

export function ClipIcon({ size = 17, color = '#94A3B8' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 18 18" fill="none" stroke={color} strokeWidth={1.3}>
      <path d="M11.5 5.5 6.8 10.2a2.3 2.3 0 0 0 3.2 3.2l5-5a4 4 0 0 0-5.6-5.6L4 7.2a5.6 5.6 0 0 0 8 8" />
    </svg>
  )
}

/** The three message-footer actions: copy, useful, retry. */
export function CopyIcon({ size = 15, color = '#94A3B8' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.3} style={{ cursor: 'pointer' }}>
      <rect x="2.5" y="2.5" width="8" height="8" rx="1.5" />
      <path d="M5.5 13.5h6a2 2 0 0 0 2-2v-6" />
    </svg>
  )
}

export function ThumbIcon({ size = 15, color = '#94A3B8' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.3} style={{ cursor: 'pointer' }}>
      <path d="M5 14V7l3-5 1 .6c.6.4.8 1.1.6 1.8L9 7h3.6c.9 0 1.6.9 1.3 1.8l-1.2 4A2 2 0 0 1 10.8 14Z" />
      <path d="M2 7h3v7H2Z" />
    </svg>
  )
}

export function RetryIcon({ size = 15, color = '#94A3B8' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.3} style={{ cursor: 'pointer' }}>
      <path d="M13.5 8a5.5 5.5 0 1 1-2-4.2" />
      <path d="M13.8 1.8v3h-3" />
    </svg>
  )
}

/** Clear the branch chat — bubble with a minus, not “add another chat”. */
export function ClearChatIcon({ size = 14, color = '#94A3B8' }: IconProps) {
  return (
    <svg {...S(size)} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4}>
      <path d="M2.5 4.2A1.7 1.7 0 0 1 4.2 2.5h7.6A1.7 1.7 0 0 1 13.5 4.2v4.6a1.7 1.7 0 0 1-1.7 1.7H7l-3.2 2.6v-2.6a1.3 1.3 0 0 1-1.3-1.3Z" />
      <path d="M5.5 8h5" />
    </svg>
  )
}
