/**
 * 极简内存限流：滑动窗口，够用且不会拖慢请求。
 * 单机部署够用；多实例部署需要换成 Redis。
 */
const buckets = new Map();

function hit(key, windowMs, max) {
  const now = Date.now();
  let item = buckets.get(key);
  if (!item || now - item.start > windowMs) {
    item = { start: now, count: 0 };
    buckets.set(key, item);
  }
  item.count += 1;
  if (item.count > max) {
    return { ok: false, retryAfter: Math.ceil((item.start + windowMs - now) / 1000) };
  }
  return { ok: true };
}

// 定期清掉过期计数，避免内存无限增长
setInterval(() => {
  const now = Date.now();
  buckets.forEach((item, key) => {
    if (now - item.start > 10 * 60 * 1000) buckets.delete(key);
  });
}, 5 * 60 * 1000).unref();

module.exports = { hit };
