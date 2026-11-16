/**
 * 可选依赖的模块声明垫片（shims）
 *
 * 这些插件包本身不附带 TypeScript 类型声明，为避免 `vue-tsc --noEmit` 报
 * "Cannot find module" 而提供宽松的 any 声明。真正的类型在各自引擎适配器中
 * 均以 any 消费，仅用于运行时动态导入（import()）。
 */

declare module 'dashjs' {
  export const MediaPlayer: any
  const dashjs: any
  export default dashjs
}

declare module 'webtorrent' {
  const WebTorrent: any
  export default WebTorrent
}

declare module 'webtorrent/dist/webtorrent.min.js' {
  const WebTorrent: any
  export default WebTorrent
}