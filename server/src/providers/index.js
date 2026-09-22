/**
 * 解析服务商选择器
 * ------------------------------------------------------------------
 * 支持「主服务商 + 兜底服务商」：
 *   先用 PARSE_PROVIDER（推荐 selfhosted，省钱），失败自动降级到 PARSE_FALLBACK_PROVIDER（推荐 http，稳）。
 *   降级会记进统计（server.parse_downgraded），看板上能看到自建的成功率，
 *   一旦自建大面积失败就知道是平台改版了，该去修适配器。
 * ------------------------------------------------------------------
 */
const config = require('../config');
const logger = require('../logger');

const providers = {
  mock: require('./mock'),
  http: require('./http'),
  selfhosted: require('./selfhosted'),
};

function get(name) {
  return providers[name] || null;
}

function current() {
  const provider = get(config.parse.provider);
  if (!provider) {
    logger.warn('未知的解析服务商:', config.parse.provider, '，已回退到 mock（演示模式）');
    return providers.mock;
  }
  return provider;
}

/**
 * 统一的解析入口：主服务商失败自动走兜底
 * @param {object} ctx { url, baseUrl }
 * @returns {Promise<object>} 解析结果，额外带 provider / downgraded 字段
 */
async function parse(ctx) {
  const attempts = [config.parse.provider];
  const fallback = config.parse.fallbackProvider;
  if (fallback && fallback !== config.parse.provider && get(fallback)) {
    attempts.push(fallback);
  }

  let lastError = null;
  for (let i = 0; i < attempts.length; i += 1) {
    const name = attempts[i];
    const provider = get(name);
    if (!provider) continue;
    const started = Date.now();
    try {
      const result = await provider.parse(ctx);
      if (i > 0) {
        logger.warn('已降级到', name, '解析成功（主服务商', attempts[0], '失败）');
      }
      return Object.assign(result, {
        provider: result.provider || name,
        downgraded: i > 0,
        provider_attempts: attempts.slice(0, i + 1),
        provider_cost_ms: Date.now() - started,
      });
    } catch (err) {
      lastError = err;
      logger.warn('解析服务商', name, '失败:', err.message);
    }
  }

  throw lastError || Object.assign(new Error('解析失败'), { code: 1002 });
}

module.exports = { parse, providers, current };
