/**
 * 自建解析用的 HTTP 工具
 * 特点：带 Cookie 罐（平台的分享页需要先拿到 ttwid 这类凭证才吐数据）、
 *      能手动跟随重定向（短链跳转要自己一步步跟，才能从 location 里掏出作品 ID）。
 */

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class HttpClient {
  constructor(options = {}) {
    this.ua = options.ua || UA_MOBILE;
    this.timeout = options.timeout || 15000;
    this.jar = {};
  }

  cookieHeader() {
    return Object.keys(this.jar)
      .map((k) => k + '=' + this.jar[k])
      .join('; ');
  }

  setCookie(name, value) {
    this.jar[name] = value;
  }

  /** 把响应里的 Set-Cookie 收进 Cookie 罐 */
  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    list.forEach((line) => {
      const pair = String(line).split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) this.jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    });
  }

  async request(url, options = {}) {
    const headers = Object.assign(
      {
        'user-agent': this.ua,
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      options.headers || {}
    );
    const cookie = this.cookieHeader();
    if (cookie && !headers.cookie) headers.cookie = cookie;

    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      redirect: options.redirect || 'manual',
      signal: AbortSignal.timeout(options.timeout || this.timeout),
    });
    this.absorb(res);
    return res;
  }

  async getText(url, options = {}) {
    const res = await this.request(url, options);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, url: res.url };
  }

  async postJson(url, body, options = {}) {
    const res = await this.request(
      url,
      Object.assign({}, options, {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, (options && options.headers) || {}),
        body: JSON.stringify(body),
      })
    );
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  /**
   * 跟随重定向，返回最终地址
   * @param {number} maxHops 最多跟几次
   */
  async follow(url, maxHops = 5, options = {}) {
    let current = url;
    for (let i = 0; i < maxHops; i += 1) {
      const res = await this.request(current, Object.assign({}, options, { redirect: 'manual' }));
      const location = res.headers.get('location');
      // 把响应体丢掉，避免连接占着不放
      if (res.body) res.body.cancel().catch(() => {});
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      return current;
    }
    return current;
  }
}

module.exports = { HttpClient, UA_MOBILE, UA_DESKTOP };
