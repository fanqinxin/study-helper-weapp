/**
 * 模块引用检查
 *
 * 解决两类容器启动即崩的问题（node --check 查不出来，因为它只校验语法）：
 *   1. require('./x') 相对路径写错 —— 文件不存在
 *   2. require('pkg') 包没写进 package.json dependencies
 *      —— 本地能跑是因为 node_modules 里有，容器 --omit=dev 装完就没了
 *
 * 用法：node scripts/check-requires.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** 已声明的依赖（含 devDependencies，容器里 dev 依赖缺失另算） */
const deps = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
]);
const prodDeps = new Set(Object.keys(pkg.dependencies || {}));

/** Node 内置模块，不需要声明 */
const BUILTIN = new Set(require('module').builtinModules);

const files = [];
function walk(d) {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(p);
    } else if (e.name.endsWith('.js')) {
      files.push(p);
    }
  }
}
walk(SRC);
// 运营脚本同样会在容器里执行（seed.js 等），引用写错一样会崩，一起纳入检查
walk(path.join(ROOT, 'scripts'));

const RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

/** 相对路径能否落到真实文件 */
function resolves(fromFile, reqPath) {
  const base = path.resolve(path.dirname(fromFile), reqPath);
  const candidates = [base, base + '.js', base + '.json', path.join(base, 'index.js')];
  return candidates.some((c) => fs.existsSync(c) && fs.statSync(c).isFile());
}

/** 'a/b' -> 'a'；'@scope/pkg/sub' -> '@scope/pkg' */
function pkgName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const brokenPath = [];
const missingDep = [];
const devOnly = [];
let totalRel = 0;
let totalBare = 0;

/**
 * 去掉注释再匹配
 * 否则文档注释里的示例（如 require('./x')）会被当成真实引用误报
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')        // /* ... */
    .replace(/(^|[^:])\/\/.*$/gm, '$1');      // // ...（排除 http:// 这类协议）
}

for (const f of files) {
  const src = stripComments(fs.readFileSync(f, 'utf8'));
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(src))) {
    const spec = m[1];
    const rel = path.relative(ROOT, f);

    if (spec.startsWith('.')) {
      totalRel++;
      if (!resolves(f, spec)) brokenPath.push({ file: rel, spec });
      continue;
    }

    const name = pkgName(spec);
    if (BUILTIN.has(name) || name.startsWith('node:')) continue;

    totalBare++;
    if (!deps.has(name)) {
      missingDep.push({ file: rel, spec: name });
    } else if (!prodDeps.has(name)) {
      // 只在 devDependencies 里：本地能跑，容器 --omit=dev 会崩
      devOnly.push({ file: rel, spec: name });
    }
  }
}

console.log('扫描 ' + files.length + ' 个文件');
console.log('  相对引用 ' + totalRel + ' 条，三方包 ' + totalBare + ' 条');

let failed = false;

if (brokenPath.length) {
  failed = true;
  console.log('\n[错误] 相对路径无法解析（文件不存在）' + brokenPath.length + ' 条：');
  for (const b of brokenPath) console.log('  ' + b.file + '  ->  ' + b.spec);
}

if (missingDep.length) {
  failed = true;
  console.log('\n[错误] 未在 package.json 声明' + missingDep.length + ' 条：');
  for (const b of missingDep) console.log('  ' + b.file + '  ->  ' + b.spec);
}

if (devOnly.length) {
  failed = true;
  console.log('\n[错误] 只在 devDependencies，容器 --omit=dev 后不可用' + devOnly.length + ' 条：');
  for (const b of devOnly) console.log('  ' + b.file + '  ->  ' + b.spec);
}

if (failed) {
  console.log('\n模块引用检查未通过');
  process.exit(1);
}

console.log('模块引用检查通过');
