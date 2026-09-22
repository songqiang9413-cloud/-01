// 清掉冒烟测试产生的数据目录（写死路径，只删项目内的 server/data）
const fs = require('fs');
const path = require('path');
const target = path.resolve(__dirname, '..', 'server', 'data');
const root = path.resolve(__dirname, '..');
if (!target.startsWith(root) || !target.endsWith(path.join('server', 'data'))) {
  console.error('路径校验失败，已中止:', target);
  process.exit(1);
}
console.log('清理:', target);
fs.rmSync(target, { recursive: true, force: true });
console.log('已清空');
