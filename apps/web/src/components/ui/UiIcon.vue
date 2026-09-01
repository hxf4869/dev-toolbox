<script setup lang="ts">
import {
  ArrowLeftRight,
  BadgeCheck,
  Binary,
  BookOpen,
  Boxes,
  Braces,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock,
  Cloud,
  CodeXml,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Hash,
  History,
  House,
  Image,
  Info,
  Inbox,
  KeyRound,
  Languages,
  Link2,
  LockKeyhole,
  LogOut,
  Menu,
  MoreHorizontal,
  Monitor,
  Moon,
  Paperclip,
  Pencil,
  Plus,
  Play,
  Regex,
  RotateCcw,
  Save,
  ScanText,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Star,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Square,
  Sun,
  Tag,
  Trash2,
  TriangleAlert,
  Upload,
  WifiOff,
  Wrench,
  X,
  XCircle,
} from 'lucide-vue-next'
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    name:
      | 'arrow-left-right'
      | 'badge-check'
      | 'binary'
      | 'book-open'
      | 'boxes'
      | 'braces'
      | 'calendar-clock'
      | 'check'
      | 'check-circle-2'
      | 'chevron-down'
      | 'chevron-left'
      | 'chevron-right'
      | 'circle-help'
      | 'clock'
      | 'cloud'
      | 'code-xml'
      | 'copy'
      | 'download'
      | 'eye'
      | 'eye-off'
      | 'file-code-2'
      | 'file-text'
      | 'folder'
      | 'folder-open'
      | 'hash'
      | 'history'
      | 'house'
      | 'image'
      | 'info'
      | 'inbox'
      | 'key-round'
      | 'languages'
      | 'link-2'
      | 'lock-keyhole'
      | 'log-out'
      | 'menu'
      | 'more-horizontal'
      | 'monitor'
      | 'moon'
      | 'paperclip'
      | 'pencil'
      | 'plus'
      | 'play'
      | 'regex'
      | 'rotate-ccw'
      | 'save'
      | 'scan-text'
      | 'search'
      | 'settings'
      | 'sliders-horizontal'
      | 'sparkles'
      | 'star'
      | 'shield-alert'
      | 'shield-check'
      | 'smartphone'
      | 'square'
      | 'sun'
      | 'tag'
      | 'trash-2'
      | 'triangle-alert'
      | 'upload'
      | 'wifi-off'
      | 'wrench'
      | 'x'
      | 'x-circle'
    size?: number
  }>(),
  { size: 18 },
)

const icons = {
  'arrow-left-right': ArrowLeftRight,
  'badge-check': BadgeCheck,
  binary: Binary,
  'book-open': BookOpen,
  boxes: Boxes,
  braces: Braces,
  'calendar-clock': CalendarClock,
  check: Check,
  'check-circle-2': CheckCircle2,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'circle-help': CircleHelp,
  clock: Clock,
  cloud: Cloud,
  'code-xml': CodeXml,
  copy: Copy,
  download: Download,
  eye: Eye,
  'eye-off': EyeOff,
  'file-code-2': FileCode2,
  'file-text': FileText,
  folder: Folder,
  'folder-open': FolderOpen,
  hash: Hash,
  history: History,
  house: House,
  image: Image,
  info: Info,
  inbox: Inbox,
  'key-round': KeyRound,
  languages: Languages,
  'link-2': Link2,
  'lock-keyhole': LockKeyhole,
  'log-out': LogOut,
  menu: Menu,
  'more-horizontal': MoreHorizontal,
  monitor: Monitor,
  moon: Moon,
  paperclip: Paperclip,
  pencil: Pencil,
  plus: Plus,
  play: Play,
  regex: Regex,
  'rotate-ccw': RotateCcw,
  save: Save,
  'scan-text': ScanText,
  search: Search,
  settings: Settings,
  'sliders-horizontal': SlidersHorizontal,
  sparkles: Sparkles,
  star: Star,
  'shield-alert': ShieldAlert,
  'shield-check': ShieldCheck,
  smartphone: Smartphone,
  square: Square,
  sun: Sun,
  tag: Tag,
  'trash-2': Trash2,
  'triangle-alert': TriangleAlert,
  upload: Upload,
  'wifi-off': WifiOff,
  wrench: Wrench,
  x: X,
  'x-circle': XCircle,
} as const

const icon = computed(() => icons[props.name])
</script>

<template>
  <component :is="icon" :size="size" :stroke-width="1.8" aria-hidden="true" />
</template>
