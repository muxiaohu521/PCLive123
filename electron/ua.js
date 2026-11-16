// 统一浏览器内核 UA —— 跟随 Electron 内置 Chromium 内核版本动态生成。
// 全项目（主进程 Node 网络栈 / 各解析器）发请求统一使用，避免散落硬编码版本不一致。
// process.versions.chrome 形如 "156.0.8078.48"，仅取主版本号拼成 "156.0.0.0"，
// 与真实 Chrome 浏览器对外暴露的 UA 版本格式一致，避免暴露 Electron 标识。
const CHROME_MAJOR = (process.versions.chrome || '156').split('.')[0]

// 桌面浏览器内核 UA（Windows）
const BROWSER_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`

// 移动端浏览器内核 UA（Android，供要求移动端 UA 的接口使用，如央视 liveplayer.js）
const MOBILE_UA = `Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Mobile Safari/537.36`

module.exports = { BROWSER_UA, MOBILE_UA, CHROME_MAJOR }