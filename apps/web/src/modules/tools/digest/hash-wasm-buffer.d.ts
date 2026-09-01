// hash-wasm's browser declarations include Buffer in a union even though this
// module only supplies Uint8Array. Keep that package-local browser type visible
// without enabling every Node global in the Web tsconfig.
type Buffer = Uint8Array
