/**
 * 图标资源 —— 内联 SVG（data URI）
 *
 * 为什么用 data URI：小程序 wxss 不能直接引 svg，
 * 用 data URI 可以保持矢量清晰度，又不需要额外图片文件。
 *
 * stroke 用 currentColor 无效（data URI 中不解析），
 * 所以每个状态提供两份：默认态 / 激活态。
 */

/** 构建 svg data uri */
function svg(paths, color, size = 24) {
  const inner = paths
    .replace(/__C__/g, color)
    .replace(/__S__/g, size);
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">${inner}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(doc)}`;
}

/** 图标路径定义（__C__ 为颜色占位） */
const PATHS = {
  home: '<path d="M4 10.5 L12 4 L20 10.5 L20 20 L4 20 Z" stroke="__C__" stroke-width="2" stroke-linejoin="round"/><path d="M9.5 20 L9.5 14 L14.5 14 L14.5 20" stroke="__C__" stroke-width="2" stroke-linejoin="round"/>',
  lesson: '<path d="M5 4 L19 4 L19 20 L5 20 Z" stroke="__C__" stroke-width="2" stroke-linejoin="round"/><path d="M8.5 9 L15.5 9 M8.5 13 L15.5 13" stroke="__C__" stroke-width="2" stroke-linecap="round"/>',
  plan: '<rect x="4" y="5.5" width="16" height="15" rx="3" stroke="__C__" stroke-width="2"/><path d="M8 3 L8 7 M16 3 L16 7 M4 11 L20 11" stroke="__C__" stroke-width="2" stroke-linecap="round"/>',
  mistake: '<path d="M6 3.5 L6 20.5 M6 3.5 L18 6 L14 9 L18 12 L6 9.5" stroke="__C__" stroke-width="2" stroke-linejoin="round"/>',
  mine: '<circle cx="12" cy="8" r="4" stroke="__C__" stroke-width="2"/><path d="M4.5 20.5 C5.5 16.8 8.5 15 12 15 C15.5 15 18.5 16.8 19.5 20.5" stroke="__C__" stroke-width="2" stroke-linecap="round"/>',

  camera: '<rect x="3" y="6.5" width="18" height="14" rx="3" stroke="__C__" stroke-width="2"/><circle cx="12" cy="13.5" r="4" stroke="__C__" stroke-width="2"/><path d="M9 6.5 L10.5 4 L13.5 4 L15 6.5" stroke="__C__" stroke-width="2" stroke-linejoin="round"/>',
  book: '<path d="M5 4 L19 4 L19 20 L5 20 Z" stroke="__C__" stroke-width="2" stroke-linejoin="round"/><path d="M12 8 L13.8 12 L18 12.6 L15 15.4 L15.8 19.5 L12 17.4 L8.2 19.5 L9 15.4 L6 12.6 L10.2 12 Z" fill="__C__"/>',
  star: '<path d="M12 2.5 L15 9 L22 9.8 L16.8 14.4 L18.2 21.5 L12 18 L5.8 21.5 L7.2 14.4 L2 9.8 L9 9 Z" fill="__C__"/>',
  check: '<circle cx="12" cy="12" r="9" fill="__C__"/><path d="M8 12.3 L10.8 15.1 L16 9.5" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  back: '<path d="M15 4 L7 12 L15 20" stroke="__C__" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  arrowRight: '<path d="M9 4 L17 12 L9 20" stroke="__C__" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  bolt: '<path d="M13 2 L6 13 L11 13 L10 22 L18 10.5 L12.5 10.5 Z" fill="__C__" stroke="__C__" stroke-width="1.2" stroke-linejoin="round"/>',
  warning: '<path d="M12 3.5 L21.5 20.5 L2.5 20.5 Z" stroke="__C__" stroke-width="2.2" stroke-linejoin="round"/><path d="M12 10 L12 15" stroke="__C__" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.8" r="1.2" fill="__C__"/>',
  clock: '<circle cx="12" cy="12" r="9" stroke="__C__" stroke-width="2"/><path d="M12 7 L12 12.5 L16 15" stroke="__C__" stroke-width="2" stroke-linecap="round"/>',
  shield: '<path d="M12 2.5 C9 5.5 6 6 4 6 L4 12 C4 16.5 7.5 20 12 21.5 C16.5 20 20 16.5 20 12 L20 6 C18 6 15 5.5 12 2.5 Z" stroke="__C__" stroke-width="2" stroke-linejoin="round"/>',
  plus: '<path d="M12 5 L12 19 M5 12 L19 12" stroke="__C__" stroke-width="2.4" stroke-linecap="round"/>',
  play: '<path d="M8 5 L18 12 L8 19 Z" fill="__C__"/>',
  spark: '<path d="M12 2 L14.5 9.5 L22 12 L14.5 14.5 L12 22 L9.5 14.5 L2 12 L9.5 9.5 Z" fill="__C__"/>',
};

/** 主题色常量（与 variables.wxss 保持一致） */
const COLOR = {
  light: {
    inactive: '#A09884',
    active: '#37352F',
  },
  dark: {
    inactive: '#6E6A7C',
    active: '#37352F',
  },
};

/**
 * 获取图标 data uri
 * @param {string} name PATHS 的 key
 * @param {string} colorHex 形如 #37352F 或 rgba(...)
 * @param {number} size 显示尺寸
 */
function getIcon(name, colorHex, size = 24) {
  const p = PATHS[name];
  if (!p) return '';
  return svg(p, colorHex, size);
}

/** 生成 tabBar 所需的一组图标（默认态 + 激活态） */
function getTabIcons(theme = 'light') {
  const c = COLOR[theme] || COLOR.light;
  const names = ['home', 'lesson', 'plan', 'mistake', 'mine'];
  return names.map((n) => ({
    name: n,
    normal: getIcon(n, c.inactive, 20),
    active: getIcon(n, c.active, 20),
  }));
}

module.exports = { PATHS, COLOR, getIcon, getTabIcons, svg };
