import type { CSSProperties } from 'react'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Blocks, Check, ChevronDown as LucideChevronDown,
  ChevronLeft as LucideChevronLeft, ChevronRight as LucideChevronRight, ChevronsUpDown, ChevronUp as LucideChevronUp, Circle, CircleSlash2, Clipboard,
  File, FileCode2, FileText, Folder, FolderPlus, GitBranch, GitFork, Image, ListFilter, LoaderCircle,
  MessageCircleX, PanelBottom, PanelRight, Paperclip, Pencil, Pin, Play, RefreshCw, Search,
  Settings, Square, Trash2
} from 'lucide-react'

interface IconProps { size?: number; color?: string; style?: CSSProperties }

export {
  ChevronsUpDown,
  ArrowDown as ArrowDownIcon, ArrowLeft as CaretLeft, ArrowRight as CaretRight, Blocks as ToolIcon,
  Check as CheckIcon, LucideChevronDown as ChevronDown, LucideChevronRight as ChevronRight,
  LucideChevronLeft as ChevronLeft, LucideChevronUp as ChevronUp, Circle as CircleIcon, CircleSlash2 as CancelIcon, Clipboard as CopyIcon,
  File as FileIcon, Folder as FolderIcon, FolderPlus as FolderPlusIcon, GitBranch as BranchIcon,
  GitFork as GitIcon, ListFilter as ProjectIcon, MessageCircleX as ClearChatIcon,
  PanelBottom as SplitDownIcon, PanelRight as SplitRightIcon, Paperclip as ClipIcon, Pencil as EditIcon,
  Pin as PinIcon, Play as PlayIcon, RefreshCw as RefreshIcon, Search as SearchIcon,
  Settings as SettingsIcon, Square as StopIcon, Trash2 as DeleteIcon
}

export function Spinner({ size = 13, color = '#E3F86C', style }: IconProps) {
  return <LoaderCircle size={size} color={color} style={{ animation: 'bfspin 1.1s linear infinite', ...style }} />
}

export function SendIcon({ size = 15, color, style }: IconProps) {
  return <ArrowUp size={size} color={color} style={style} />
}

export function StatusMark({ done = false, size = 22 }: { done?: boolean; size?: number }) {
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', background: done ? '#D6F23A' : '#2A2A28',
      display: 'grid', placeItems: 'center', flex: 'none' }}>
      {done ? <Check size={Math.round(size * 0.5)} color="#1B1D13" /> : null}
    </span>
  )
}

export function AttachmentIcon({ kind, size = 24 }: IconProps & { kind: string }) {
  const Attachment = kind === 'Image' ? Image : kind === 'HTML' ? FileCode2 : FileText
  return <Attachment aria-hidden="true" size={size} style={{ flexShrink: 0 }} />
}

export function UserIcon({ size = 14, color = 'currentColor' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </svg>
  )
}
