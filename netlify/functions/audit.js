const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let targetUrl;
  try {
    const body = JSON.parse(event.body || '{}');
    targetUrl = body.url;
    if (!targetUrl) throw new Error('URL is required');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid URL payload' }) };
  }

  try {
    const startTime = Date.now();
    const res = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 12000
    });

    const html = res.data;
    const responseTime = Date.now() - startTime;
    const $ = cheerio.load(html);
    const domain = new URL(targetUrl).hostname;

    let score = 0;
    const checks = [];

    function addCheck(name, category, pass, points, message) {
      if (pass) score += points;
      checks.push({ name, category, pass, points: pass ? points : 0, maxPoints: points, message });
    }

    // 1. Static Text Volume & Density (35 pts)
    const rawBodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const wordCount = rawBodyText.split(' ').filter(w => w.length > 0).length;
    addCheck('Static Word Count', 'Content Value', wordCount >= 900, 15, 
      wordCount >= 900 ? `${wordCount} words detected (Threshold: ≥900)` : `Thin text detected: only ${wordCount} words found`);

    const textRatio = ((rawBodyText.length / html.length) * 100).toFixed(1);
    addCheck('Text-to-HTML Ratio', 'Content Value', textRatio >= 10, 10, 
      `${textRatio}% text density (Threshold: ≥10%)`);

    const codeBlocks = $('pre code, pre, code').length;
    const tables = $('table').length;
    addCheck('Structured Elements', 'Content Value', codeBlocks > 0 || tables > 0, 10, 
      `Found ${codeBlocks} code block(s) and ${tables} data table(s)`);

    // 2. Technical E-E-A-T & Trust (30 pts)
    let hasSchema = false;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html());
        const type = json['@type'] || (json['@graph'] && json['@graph'].map(g => g['@type']).join(','));
        if (type && /Article|TechArticle|ScholarlyArticle|WebPage/i.test(type)) hasSchema = true;
      } catch (_) {}
    });
    addCheck('JSON-LD Schema Markup', 'E-E-A-T Signals', hasSchema, 10, 
      hasSchema ? 'Valid Article or TechArticle Schema found' : 'No Schema.org Article metadata detected');

    const author = $('meta[name="author"]').attr('content') \vert{}\vert{} $('[class*="author"], [id*="author"], [rel="author"]').text().trim();
    const hasAuthor = author.length > 2 && !/admin|editor|team/i.test(author);
    addCheck('Named Author Credential', 'E-E-A-T Signals', hasAuthor, 10, 
      hasAuthor ? `Author verified: ${author.slice(0, 30)}` : 'Missing or anonymous author attribution');

    const hasReferences = /References|Citations|Sources|Bibliography/i.test(rawBodyText);
    addCheck('Academic & Source Citations', 'E-E-A-T Signals', hasReferences, 10, 
      hasReferences ? 'Formal citations/sources section identified' : 'No structured references section found');

    // 3. Essential Crawl Paths & Transparency (20 pts)
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
      `Privacy Policy: ${hasPrivacy ? 'Yes' : 'No'} | About/Contact: ${hasContact || hasAbout ? 'Yes' : 'No'}`);

    addCheck('Internal Crawl Paths', 'Compliance', internalLinks >= 3, 10, 
      `${internalLinks} internal link(s) discovered for crawler discovery`);

    // 4. Working Utility & Mobile Layout (15 pts)
    addCheck('Subdirectory Proof-of-Work', 'Utility', interactiveSubdir, 10, 
      interactiveSubdir ? 'Active link to /games/, /quiz/, or /tools/ found' : 'No functional utility link identified');

    const hasViewport = $('meta[name="viewport"]').length > 0;
    addCheck('Mobile Responsive Viewport', 'Utility', hasViewport, 5, 
      hasViewport ? 'Configured for mobile viewports' : 'Missing responsive viewport meta tag');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score, checks, responseTime, url: targetUrl })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `Crawl Failed: ${err.message}` })
    };
  }
};
