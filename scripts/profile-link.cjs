// 把 dsh-desk 挂进 / 摘出 desktop profile。
//   node profile-link.cjs install | uninstall
// 只动 package.json 的两处和 node_modules 里一个 junction。写文件前先备份，写出来不带 BOM。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NAME = 'dsh-desk';
const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const PKG = path.join(PROFILE, 'package.json');
const LINK = path.join(PROFILE, 'node_modules', NAME);

const raw = fs.readFileSync(PKG, 'utf8').replace(/^﻿/, '');
const pkg = JSON.parse(raw);
const bundles = pkg.dsh?.profile?.bundles;
// 没有这张清单时自己造一张会把官方的基础包挤掉，宁可停下
if (!Array.isArray(bundles)) {
  console.error(`${PKG} 里没有 dsh.profile.bundles，这个 DeepSeek Harness 版本的插件挂法可能变了`);
  process.exit(1);
}
pkg.dependencies ??= {};

function save() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(PKG, `${PKG}.bak-${stamp}`);
  fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', { encoding: 'utf8' });
}

const action = process.argv[2];
if (action === 'install') {
  pkg.dependencies[NAME] = `link:${ROOT.replace(/\\/g, '/')}`;
  if (!bundles.includes(NAME)) bundles.push(NAME);
  save();
  fs.mkdirSync(path.dirname(LINK), { recursive: true });
  if (!fs.existsSync(LINK)) fs.symlinkSync(ROOT, LINK, 'junction');
  console.log('linked', LINK, '->', ROOT);
} else if (action === 'uninstall') {
  delete pkg.dependencies[NAME];
  pkg.dsh.profile.bundles = bundles.filter((b) => b !== NAME);
  save();
  // junction 只删链接本身，不碰源目录
  if (fs.existsSync(LINK)) fs.rmSync(LINK, { recursive: false, force: true });
  console.log('unlinked', LINK);
} else {
  console.error('usage: profile-link.cjs install|uninstall');
  process.exit(1);
}
