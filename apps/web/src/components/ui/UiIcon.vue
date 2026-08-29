<script setup lang="ts">
import {
  BookOpen,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  Folder,
  FolderOpen,
  History,
  Image,
  Inbox,
  KeyRound,
  LockKeyhole,
  LogOut,
  Menu,
  MoreHorizontal,
  Monitor,
  Moon,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Star,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sun,
  Tag,
  Trash2,
  TriangleAlert,
  Upload,
  WifiOff,
  Wrench,
  X,
} from 'lucide-vue-next'
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    name:
      | 'book-open'
      | 'boxes'
      | 'check'
      | 'chevron-left'
      | 'chevron-right'
      | 'circle-help'
      | 'clock'
      | 'copy'
      | 'download'
      | 'eye'
      | 'eye-off'
      | 'file-text'
      | 'folder'
      | 'folder-open'
      | 'history'
      | 'image'
      | 'inbox'
      | 'key-round'
      | 'lock-keyhole'
      | 'log-out'
      | 'menu'
      | 'more-horizontal'
      | 'monitor'
      | 'moon'
      | 'paperclip'
      | 'pencil'
      | 'plus'
      | 'rotate-ccw'
      | 'save'
      | 'search'
      | 'settings'
      | 'sliders-horizontal'
      | 'sparkles'
      | 'star'
      | 'shield-alert'
      | 'shield-check'
      | 'smartphone'
      | 'sun'
      | 'tag'
      | 'trash-2'
      | 'triangle-alert'
      | 'upload'
      | 'wifi-off'
      | 'wrench'
      | 'x'
    size?: number
  }>(),
  { size: 18 },
)

const icons = {
  'book-open': BookOpen,
  boxes: Boxes,
  check: Check,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'circle-help': CircleHelp,
  clock: Clock,
  copy: Copy,
  download: Download,
  eye: Eye,
  'eye-off': EyeOff,
  'file-text': FileText,
  folder: Folder,
  'folder-open': FolderOpen,
  history: History,
  image: Image,
  inbox: Inbox,
  'key-round': KeyRound,
  'lock-keyhole': LockKeyhole,
  'log-out': LogOut,
  menu: Menu,
  'more-horizontal': MoreHorizontal,
  monitor: Monitor,
  moon: Moon,
  paperclip: Paperclip,
  pencil: Pencil,
  plus: Plus,
  'rotate-ccw': RotateCcw,
  save: Save,
  search: Search,
  settings: Settings,
  'sliders-horizontal': SlidersHorizontal,
  sparkles: Sparkles,
  star: Star,
  'shield-alert': ShieldAlert,
  'shield-check': ShieldCheck,
  smartphone: Smartphone,
  sun: Sun,
  tag: Tag,
  'trash-2': Trash2,
  'triangle-alert': TriangleAlert,
  upload: Upload,
  'wifi-off': WifiOff,
  wrench: Wrench,
  x: X,
} as const

const icon = computed(() => icons[props.name])
</script>

<template>
  <component :is="icon" :size="size" :stroke-width="1.8" aria-hidden="true" />
</template>
