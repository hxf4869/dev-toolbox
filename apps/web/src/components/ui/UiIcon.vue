<script setup lang="ts">
import {
  BookOpen,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  Folder,
  Image,
  Inbox,
  KeyRound,
  LockKeyhole,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Paperclip,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sun,
  Trash2,
  TriangleAlert,
  Upload,
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
      | 'copy'
      | 'download'
      | 'eye'
      | 'eye-off'
      | 'file-text'
      | 'folder'
      | 'image'
      | 'inbox'
      | 'key-round'
      | 'lock-keyhole'
      | 'log-out'
      | 'menu'
      | 'monitor'
      | 'moon'
      | 'paperclip'
      | 'plus'
      | 'rotate-ccw'
      | 'save'
      | 'search'
      | 'settings'
      | 'shield-alert'
      | 'shield-check'
      | 'smartphone'
      | 'sun'
      | 'trash-2'
      | 'triangle-alert'
      | 'upload'
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
  copy: Copy,
  download: Download,
  eye: Eye,
  'eye-off': EyeOff,
  'file-text': FileText,
  folder: Folder,
  image: Image,
  inbox: Inbox,
  'key-round': KeyRound,
  'lock-keyhole': LockKeyhole,
  'log-out': LogOut,
  menu: Menu,
  monitor: Monitor,
  moon: Moon,
  paperclip: Paperclip,
  plus: Plus,
  'rotate-ccw': RotateCcw,
  save: Save,
  search: Search,
  settings: Settings,
  'shield-alert': ShieldAlert,
  'shield-check': ShieldCheck,
  smartphone: Smartphone,
  sun: Sun,
  'trash-2': Trash2,
  'triangle-alert': TriangleAlert,
  upload: Upload,
  wrench: Wrench,
  x: X,
} as const

const icon = computed(() => icons[props.name])
</script>

<template>
  <component :is="icon" :size="size" :stroke-width="1.8" aria-hidden="true" />
</template>
