export type YamlWorkerRequest =
  | { operation: 'format'; text: string }
  | { operation: 'to-json'; text: string }
  | { operation: 'from-json'; text: string }

export type YamlWorkerResult =
  | { operation: 'format'; output: string; documentCount: number }
  | { operation: 'to-json'; output: string; documentCount: number; outputForm: 'single' | 'array' }
  | { operation: 'from-json'; output: string }
