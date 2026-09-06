const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache'
};

export interface TempEmailResult {
  success: boolean;
  email: string;
  username: string;
  domain: string;
  url: string;
  cookie: string;
}

export interface InboxMessage {
  id: string | number;
  from: string;
  subject: string;
  time: string;
}

export interface InboxResult {
  success: boolean;
  email: string;
  url: string;
  count: number;
  messages: InboxMessage[];
  bodyContent: string | null;
}

export function parseEmailTarget(targetStr: string): { domain: string; username: string } | null {
  if (!targetStr) return null;
  targetStr = targetStr.trim();

  if (targetStr.startsWith('http://') || targetStr.startsWith('https://')) {
    try {
      const parsedUrl = new URL(targetStr);
      const parts = parsedUrl.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return { domain: parts[0], username: parts[1] };
      }
    } catch (e) {}
  }

  if (targetStr.includes('@')) {
    const [username, domain] = targetStr.split('@');
    if (username && domain) {
      return { domain: domain.trim(), username: username.trim() };
    }
  }

  if (targetStr.includes('/')) {
    const parts = targetStr.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return { domain: parts[0], username: parts[1] };
    }
  }

  return null;
}

export async function generateEmail(customDomain = '', customUsername = ''): Promise<TempEmailResult> {
  let targetUrl = 'https://generator.email/';
  const headers: Record<string, string> = { ...DEFAULT_HEADERS };

  if (customDomain && customUsername) {
    targetUrl = `https://generator.email/${customDomain}/${customUsername}`;
    headers['Cookie'] = `inbox_ctx=${encodeURIComponent(customDomain)}%2F${encodeURIComponent(customUsername)}%2F`;
  }

  const response = await fetch(targetUrl, { headers });
  const html = await response.text();
  
  let setCookies: string[] = [];
  const setCookieHeader = response.headers.get('set-cookie');
  if (setCookieHeader) {
    setCookies = setCookieHeader.split(/,(?=[^ ]+=)/);
  }

  let domain = customDomain;
  let username = customUsername;

  const ctxCookie = setCookies.find(c => c.includes('inbox_ctx='));
  if (ctxCookie) {
    const match = ctxCookie.match(/inbox_ctx=([^%]+)%2F([^%]+)%2F/);
    if (match) {
      domain = domain || decodeURIComponent(match[1]);
      username = username || decodeURIComponent(match[2]);
    }
  }

  if (!username) {
    const userMatch = html.match(/id="userName"[^>]*value="([^"]*)"/i) || html.match(/name="userName"[^>]*value="([^"]*)"/i);
    if (userMatch) username = userMatch[1];
  }
  
  if (!domain) {
    const domainMatch = html.match(/id="domainName2"[^>]*value="([^"]*)"/i) || html.match(/name="domainName"[^>]*value="([^"]*)"/i);
    if (domainMatch) domain = domainMatch[1];
  }

  let email = '';
  const emailTextMatch = html.match(/id="email_ch_text"[^>]*>([^<]+)</i);
  if (emailTextMatch) {
    email = emailTextMatch[1].trim();
  }
  
  if (!email && username && domain) {
    email = `${username}@${domain}`;
  }

  const url = `https://generator.email/${domain}/${username}`;

  return {
    success: true,
    email,
    username,
    domain,
    url,
    cookie: `inbox_ctx=${encodeURIComponent(domain)}%2F${encodeURIComponent(username)}%2F`
  };
}

export async function getInbox(targetStr: string): Promise<InboxResult> {
  const parsed = parseEmailTarget(targetStr);
  if (!parsed) {
    throw new Error(`Format target tidak valid. Gunakan URL (https://generator.email/domain/user) atau email (user@domain).`);
  }

  const { domain, username } = parsed;
  const url = `https://generator.email/${domain}/${username}`;
  const cookieValue = `inbox_ctx=${encodeURIComponent(domain)}%2F${encodeURIComponent(username)}%2F`;

  const response = await fetch(url, {
    headers: {
      ...DEFAULT_HEADERS,
      'Cookie': cookieValue
    }
  });

  const html = await response.text();
  const messages: InboxMessage[] = [];

  const listItemsMatches = Array.from(html.matchAll(/<div[^>]*class="[^"]*list-group-item[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/a>|<a[^>]*class="[^"]*list-group-item[^"]*"[^>]*>[\s\S]*?<\/a>/gi));

  let index = 0;
  for (const match of listItemsMatches) {
    const el = match[0];
    if (el.includes('active')) continue; 

    let fromMatch = el.match(/class="[^"]*from[^"]*"[^>]*>([^<]+)</i);
    let subjectMatch = el.match(/class="[^"]*subj[^"]*"[^>]*>([^<]+)</i);
    let timeMatch = el.match(/class="[^"]*time[^"]*"[^>]*>([^<]+)</i);
    let midMatch = el.match(/data-mid="([^"]+)"/i);

    const from = fromMatch ? fromMatch[1].trim() : 'Unknown';
    const subject = subjectMatch ? subjectMatch[1].trim() : 'No Subject';
    const time = timeMatch ? timeMatch[1].trim() : 'Unknown';
    const mid = midMatch ? midMatch[1] : String(index);

    if (from !== 'Unknown' || subject !== 'No Subject') {
      messages.push({
        id: mid,
        from,
        subject,
        time
      });
    }
    index++;
  }

  let bodyContent = null;
  const markodileMatch = html.match(/id="markodile"[^>]*>([\s\S]*?)<\/div>/i);
  if (markodileMatch) {
    bodyContent = markodileMatch[1].replace(/<[^>]+>/g, '').trim();
  } else {
    const emailTableMatch = html.match(/class="[^"]*email-table[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
    if (emailTableMatch) {
      bodyContent = emailTableMatch[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  return {
    success: true,
    email: `${username}@${domain}`,
    url,
    count: messages.length,
    messages,
    bodyContent
  };
}

export async function pollInbox(targetStr: string, options: { intervalMs?: number, maxAttempts?: number, onProgress?: (attempt: number, inbox: InboxResult) => void } = {}): Promise<InboxResult> {
  const intervalMs = options.intervalMs || 5000;
  const maxAttempts = options.maxAttempts || 12;
  const onProgress = options.onProgress || null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const inbox = await getInbox(targetStr);
      if (onProgress) onProgress(attempt, inbox);

      if (inbox.count > 0) {
        return inbox;
      }
    } catch (err) {
      console.error(`[Attempt ${attempt}/${maxAttempts}] Error: ${err}`);
    }

    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  return await getInbox(targetStr);
}
