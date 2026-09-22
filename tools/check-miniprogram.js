const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
let problems = 0;

function walk(dir, out = []) {
  fs.readdirSync(dir).forEach((name) => {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  });
  return out;
}

const files = walk(ROOT);

/** 去掉注释，避免把文档注释里的示例代码当成真实引用 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

/* 1) require 路径存在性 */
files.filter((f) => f.endsWith('.js')).forEach((file) => {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const re = /require\(['"]([^'"]+)['"]\)/g;
  let m;
  while ((m = re.exec(src))) {
    const p = m[1];
    if (p.startsWith('plugin://') || p.startsWith('/')) continue;
    const target = path.resolve(path.dirname(file), p);
    const candidates = [target, target + '.js', path.join(target, 'index.js')];
    if (!candidates.some((c) => fs.existsSync(c))) {
      console.error('[X] require 找不到:', path.relative(ROOT, file), '->', p);
      problems += 1;
    }
  }
});

/* 2) WXML 绑定的事件是否存在 & 自定义组件是否声明 */
files.filter((f) => f.endsWith('.wxml')).forEach((wxml) => {
  const jsFile = wxml.replace(/\.wxml$/, '.js');
  const jsonFile = wxml.replace(/\.wxml$/, '.json');
  const src = fs.readFileSync(wxml, 'utf8');

  if (fs.existsSync(jsFile)) {
    const js = fs.readFileSync(jsFile, 'utf8');
    const re = /\b(?:bind|catch|capture-bind|capture-catch)[:]?([a-zA-Z]+)\s*=\s*"([^"{}]+)"/g;
    let m;
    while ((m = re.exec(src))) {
      const handler = m[2].trim();
      if (!handler) continue;
      const patterns = [new RegExp('\\b' + handler + '\\s*[:(]'), new RegExp("'" + handler + "'")];
      if (!patterns.some((p) => p.test(js))) {
        console.error('[X] WXML 绑定了不存在的方法:', path.relative(ROOT, wxml), '->', handler);
        problems += 1;
      }
    }
  }

  const comps = [];
  const cre = /<([a-z][a-z0-9]*-[a-z0-9-]+)[\s/>]/g;
  let cm;
  while ((cm = cre.exec(src))) comps.push(cm[1]);
  const uniq = Array.from(new Set(comps));
  if (uniq.length) {
    const declared = fs.existsSync(jsonFile) ? JSON.parse(fs.readFileSync(jsonFile, 'utf8')).usingComponents || {} : {};
    uniq.forEach((tag) => {
      if (!declared[tag]) {
        console.error('[X] WXML 用了未声明的组件:', path.relative(ROOT, wxml), '->', tag);
        problems += 1;
      }
    });
  }
});

/* 3) app.json 页面文件齐全 */
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
appJson.pages.forEach((p) => {
  ['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
    if (!fs.existsSync(path.join(ROOT, p + '.' + ext))) {
      console.error('[X] 页面文件缺失:', p + '.' + ext);
      problems += 1;
    }
  });
});

/* 4) tabBar 图标存在 */
((appJson.tabBar || {}).list || []).forEach((item) => {
  [item.iconPath, item.selectedIconPath].filter(Boolean).forEach((icon) => {
    if (!fs.existsSync(path.join(ROOT, icon))) {
      console.error('[X] tabBar 图标缺失:', icon);
      problems += 1;
    }
  });
});

/* 5) 页面引用的 images/xxx 存在 */
files.filter((f) => f.endsWith('.wxml') || f.endsWith('.js')).forEach((file) => {
  const src = fs.readFileSync(file, 'utf8');
  const re = /["'(]\/?images\/([A-Za-z0-9_.-]+)["')]/g;
  let m;
  while ((m = re.exec(src))) {
    if (!fs.existsSync(path.join(ROOT, 'images', m[1]))) {
      console.error('[X] 图片缺失:', m[1], '(引用自 ' + path.relative(ROOT, file) + ')');
      problems += 1;
    }
  }
});

/* 6) require 进来的模块是否真的用到了；用到的标识符是否真的 require 了
       （两种情况都会导致运行时报错或留下死代码，曾经真的踩过） */
const BUILTIN = ['require', 'module', 'exports', 'console', 'wx', 'App', 'Page', 'Component', 'behavior', 'getApp', 'getCurrentPages', 'plugin', 'Math', 'Date', 'JSON', 'Promise', 'Object', 'Array', 'String', 'Number', 'Boolean', 'RegExp', 'Error', 'Set', 'Map', 'Symbol', 'parseInt', 'parseFloat', 'isNaN', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];
files.filter((f) => f.endsWith('.js')).forEach((file) => {
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripComments(raw);
  const declared = [];
  const re = /const\s+([\w, ]+?)\s*=\s*require\(['"]([^'"]+)['"]\)/g;
  let m;
  while ((m = re.exec(src))) {
    m[1].split(',').map((x) => x.trim()).filter(Boolean).forEach((name) => declared.push({ name, from: m[2], text: m[0] }));
  }
  declared.forEach((item) => {
    const rest = src.replace(item.text, '');
    // 出现次数为 0 说明是「引了没用」的死代码
    const uses = (rest.match(new RegExp('(^|[^\\w.])' + item.name + '(?![\\w])', 'g')) || []).length;
    if (uses === 0) {
      console.warn('[!] 引了没用:', path.relative(ROOT, file), '->', item.name, '(' + item.from + ')');
    }
  });
});

console.log(problems === 0 ? '\n静态检查全部通过' : '\n发现 ' + problems + ' 个问题');
process.exitCode = problems === 0 ? 0 : 1;
