/**
 * 状态栏 / 胶囊位置计算，供自定义导航栏与 Tab Bar 复用
 *
 * 只做「单次启动内」的内存缓存。
 * 早先版本用 wx.setStorageSync 长期缓存，风险是跨机型、跨系统升级后残留旧值：
 * 例如从 statusBarHeight=20 的机型缓存到刘海机上，状态栏占位就矮了 27px，
 * 整条自定义导航被顶进系统状态栏 —— 返回键正好压在系统时间下面，
 * 看起来就像"这一页没有返回按钮"。
 */
const LEGACY_STORAGE_KEY = 'sh_system_info';

let memo = null;

function readWindow() {
  if (wx.getWindowInfo) return wx.getWindowInfo();
  return wx.getSystemInfoSync();
}

function measure() {
  const win = readWindow();
  const menu = wx.getMenuButtonBoundingClientRect
    ? wx.getMenuButtonBoundingClientRect()
    : null;

  const rawStatusBar = win.statusBarHeight || 0;
  const safeTop = (win.safeArea && win.safeArea.top) || 0;
  // 刘海 / 灵动岛机型以安全区顶部为准；两侧取大，避免任何一边取到 0
  const statusBarHeight = Math.max(rawStatusBar, safeTop, 20);

  // 导航栏高度 = 胶囊高度 + 上下间距；胶囊取不到时退回设计值
  let navBarHeight = 44;
  if (menu && menu.height) {
    if (menu.top >= statusBarHeight) {
      navBarHeight = menu.height + (menu.top - statusBarHeight) * 2;
    } else {
      navBarHeight = menu.height + 12;
    }
  }
  // 横屏 / 折叠屏 / 模拟器下胶囊坐标可能异常，收敛到可用区间
  navBarHeight = Math.min(Math.max(Math.round(navBarHeight), 40), 64);

  const screenHeight = win.screenHeight || 0;
  const safeBottom = win.safeArea
    ? Math.max(0, screenHeight - win.safeArea.bottom)
    : 0;

  return {
    statusBarHeight,
    navBarHeight,
    menuRight: (menu && menu.right) || 0,
    menuWidth: (menu && menu.width) || 87,
    safeBottom,
    windowWidth: win.windowWidth || 375,
  };
}

/**
 * 获取系统信息（同一次启动内复用，冷启动重新测量）
 */
function getSystemInfo() {
  if (memo) return memo;

  // 清掉历史版本的长期缓存，避免残留值继续影响占位高度
  try {
    if (wx.getStorageSync(LEGACY_STORAGE_KEY)) {
      wx.removeStorageSync(LEGACY_STORAGE_KEY);
    }
  } catch (e) {
    // 存储异常不影响主流程
  }

  memo = measure();
  return memo;
}

module.exports = { getSystemInfo };
