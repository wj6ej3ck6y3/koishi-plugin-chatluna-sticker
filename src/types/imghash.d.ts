declare module 'imghash' {
  export function hash(buf: Buffer, bits: number): Promise<string>
  const _default: { hash: typeof hash }
  export default _default
}