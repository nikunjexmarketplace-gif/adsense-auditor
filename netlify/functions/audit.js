const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }

  let targetUrl;
  try {
    const body = JSON.parse(event.body || '{}');
    targetUrl = body.url ? body.url.trim() : '';
    if (!targetUrl) throw new Error('URL is required');
  } catch (err) {
    return { 
      statusCode: 400, 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Please enter a valid URL' }) 
    };
  }

  const startTime = Date.now();
  let html = '';
  let fetchError = '';

  // Attempt 1: Direct fetch with Chrome desktop headers
  try {
    const directRes = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: (status) => status < 400
    });
    if (typeof directRes.data === 'string') {
      html = directRes.data;
    }
  } catch (err) {
    fetchError = err.message;
  }

  // Attempt 2: Fallback bypass for Cloudflare / datacenter firewall blocks
  if (!html) {
    try {
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
      const proxyRes = await axios.get(proxyUrl, { timeout: 12000 });
      if (proxyRes.data && proxyRes.data.contents) {
        html = proxyRes.data.contents;
      }
    } catch (proxyErr) {
      fetchError += ` | Fallback: ${proxyErr.message}`;
    }
  }

  if (!html || typeof html !== 'string' || html.length < 50) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: `Could not reach target page (${fetchError || 'Host blocked server IP'}).` 
      })
    };
  }

  try {
    const responseTime = Date.now() - startTime;
    const $ = cheerio.load(html);
    const domain = new URL(targetUrl).hostname;

    let score = 0;
    const checks = [];

    function addCheck(name, category, pass, points, message) {
      if (pass) score += points;
      checks.push({ name, category, pass, points: pass ? points : 0, maxPoints: points, message });
    }

    // 1. Text & Density
    const rawBodyText = $('article, main, .entry-content, body').first().text().replace(/\s+/g, ' ').trim();
    const wordCount = rawBodyText.split(' ').filter(w => w.length > 0).length;
    addCheck('Static Word Count', 'Content Value', wordCount >= 900, 15, 
      wordCount >= 900 ? `${wordCount} words detected (Threshold: ≥900)` : `Thin content: ${wordCount} words found`);

    const textRatio = ((rawBodyText.length / html.length) * 100).toFixed(1);
    addCheck('Text-to-HTML Ratio', 'Content Value', textRatio >= 10, 10, 
      `${textRatio}% text density (Threshold: ≥10%)`);

    const codeBlocks = $('pre code, pre, code').length;
    const tables = $('table').length;
    addCheck('Structured Elements', 'Content Value', codeBlocks > 0 || tables > 0, 10, 
      `Found ${codeBlocks} code block(s) and ${tables} table(s)`);

    // 2. Technical E-E-A-T
    let hasSchema = false;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html());
        const type = json['@type'] || (json['@graph'] && json['@graph'].map(g => g['@type']).join(','));
        if (type && /Article|TechArticle|ScholarlyArticle|WebPage|BlogPosting/i.test(type)) hasSchema = true;
      } catch (_) {}
    });
    addCheck('JSON-LD Schema Markup', 'E-E-A-T Signals', hasSchema, 10, 
      hasSchema ? 'Valid Schema markup detected' : 'No Article/BlogPosting Schema found');

    const author = $('meta[name="author"]').attr('content') \vert{}\vert{} $('[class*="author"], [id*="author"], [rel="author"]').text().trim();
    const hasAuthor = author.length > 2 && !/admin|editor|team/i.test(author);
    addCheck('Named Author Credential', 'E-E-A-T Signals', hasAuthor, 10, 
      hasAuthor ? `Author verified: ${author.slice(0, 30)}` : 'Missing or generic author name');

    const hasReferences = /References|Citations|Sources|Bibliography/i.test(rawBodyText);
    addCheck('Academic & Source Citations', 'E-E-A-T Signals', hasReferences, 10, 
      hasReferences ? 'Citations/Sources section identified' : 'No structured citations section found');

    // 3. Navigation & Compliance
    let hasPrivacy = false, hasContact = false, hasAbout = false;
    let internalLinks = 0, interactiveSubdir = false;

    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim().toLowerCase();
      if (/privacy/i.test(text) || /privacy/i.test(href)) hasPrivacy = true;
      if (/contact/i.test(text) || /contact/i.test(href)) hasContact = true;
      if (/about/i.test(text) || /about/i.test(href)) hasAbout = true;

      if (href.startsWith('/') || href.includes(domain)) {
        internalLinks++;
        if (href.includes('/games/') || href.includes('/quiz/') || href.includes('/tools/')) {
          interactiveSubdir = true;
        }
      }
    });

    addCheck('Mandatory Policy Pages', 'Compliance', hasPrivacy && (hasContact || hasAbout), 10, 
      `Privacy: ${hasPrivacy ? 'Pass' : 'Missing'} | About/Contact: ${hasContact || hasAbout ? 'Pass' : 'Missing'}`);

    addCheck('Internal Crawl Paths', 'Compliance', internalLinks >= 3, 10, 
      `${internalLinks} internal link(s) discovered`);

    // 4. Utility & Mobile
    addCheck('Subdirectory Proof-of-Work', 'Utility', interactiveSubdir, 10, 
      interactiveSubdir ? 'Active link to /games/, /quiz/, or /tools/ found' : 'No interactive subdirectory link found');

    const hasViewport = $('meta[name="viewport"]').length > 0;
    addCheck('Mobile Responsive Viewport', 'Utility', hasViewport, 5, 
      hasViewport ? 'Configured for mobile viewports' : 'Missing viewport meta tag');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score, checks, responseTime, url: targetUrl })
    };
  } catch (parseErr) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Parsing error: ${parseErr.message}` })
    };
  }
};
