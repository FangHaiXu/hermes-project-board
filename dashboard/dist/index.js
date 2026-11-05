// Web 控制台不提供看板 UI（页面由 desktop/plugin.js 在 Hermes Desktop 内渲染）。
// 这个占位模块只为让 web dashboard 的插件加载器拿到一个合法入口，不注册任何 UI。
if (typeof window !== 'undefined' && window.__HERMES_PLUGINS__) {
  window.__HERMES_PLUGINS__.register('project-board', function ProjectBoardPlaceholder() {
    return null
  })
}

export default {}
