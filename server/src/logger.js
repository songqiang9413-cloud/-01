/**
 * 极简日志：带时间戳和级别，写 stdout。
 * 想接日志平台的话，只要改这一个文件。
 */
function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`;
}

function line(level, args) {
  const text = args
    .map((item) => {
      if (item instanceof Error) return item.stack || item.message;
      if (typeof item === 'object') {
        try {
          return JSON.stringify(item);
        } catch (err) {
          return String(item);
        }
      }
      return String(item);
    })
    .join(' ');
  return `${ts()} [${level}] ${text}`;
}

module.exports = {
  info: (...args) => console.log(line('INFO', args)),
  warn: (...args) => console.warn(line('WARN', args)),
  error: (...args) => console.error(line('ERROR', args)),
};
