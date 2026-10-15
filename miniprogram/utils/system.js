/**
 * 状态栏组件的全局逻辑
 * 计算状态栏高度与胶囊位置，供所有页面复用
 */
const SYSTEM_INFO_KEY = 'sh_system_info';

/**
 * 获取系统信息（带缓存，避免频繁调用）
 */
function getSystemInfo() {
  const cached = wx.getStorageSync(SYSTEM_INFO_KEY);
  if (cached) return cached;

  const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
  const menu = wx.getMenuButtonBoundingClientRect
    ? wx.getMenuButtonBoundingClientRect()
    : { top: 0, height: 32, right: 0 };

  const info = {
    statusBarHeight: win.statusBarHeight || 20,
    // 导航栏高度 = 胶囊高度 + 上下间距；取不到时给个合理兜底
    navBarHeight: menu.height
      ? menu.height + (menu.top - (win.statusBarHeight || 20)) * 2
      : 44,
    menuRight: menu.right || 0,
    menuWidth: menu.width || 87,
    safeBottom: (win.screenHeight || 0) - (win.safeArea ? win.safeArea.bottom : 0),
    windowWidth: win.windowWidth || 375,
  };

  wx.setStorageSync(SYSTEM_INFO_KEY, info);
  return info;
}

module.exports = { getSystemInfo };
