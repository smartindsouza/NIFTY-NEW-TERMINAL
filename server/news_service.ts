import Parser from 'rss-parser';
import axios from 'axios';
import { GoogleGenAI, Type } from "@google/genai";

export interface NewsItem {
  id: string;
  headline: string;
  source: string;
  time: string; // ISO String
  timeIST: string; // Published time in IST
  category: 'India Market' | 'Global Macro' | 'Geopolitical' | 'Sector' | 'NIFTY Companies';
  sentiment: 'bullish' | 'bearish' | 'neutral';
  impactScore: number; // 0 - 100
  whyItMatters: string;
  link: string;
}

const parser = new Parser();

// In-memory cache
let cachedNews: NewsItem[] = [];
let lastFetchedTime = 0;
const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes cache

export interface AIStatus {
  success: boolean;
  lastSuccessTime: string | null;
  fallbackReason: string | null;
  geminiCount: number;
  localCount: number;
}

export let currentAIStatus: AIStatus = {
  success: false,
  lastSuccessTime: null,
  fallbackReason: "System initialized, no fetch triggered yet",
  geminiCount: 0,
  localCount: 0,
};

// Concurrency control for background fetches
let activeFetchPromise: Promise<NewsItem[]> | null = null;

// Lazy initialization of Gemini client
let aiClient: GoogleGenAI | null = null;
function getAi(): GoogleGenAI | null {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (key) {
      aiClient = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });
    }
  }
  return aiClient;
}

// Feeds to aggregate mapped via Google News to completely circumvent 403 blocks
const FEEDS = [
  { name: 'Moneycontrol Markets', url: 'https://news.google.com/rss/search?q=site:moneycontrol.com+(Nifty+OR+Sensex+OR+market+OR+RBI+OR+business)&hl=en-IN&gl=IN&ceid=IN:en' },
  { name: 'Moneycontrol Business', url: 'https://news.google.com/rss/search?q=site:moneycontrol.com+business+reforms+GDP+inflation&hl=en-IN&gl=IN&ceid=IN:en' },
  { name: 'Economic Times Markets', url: 'https://news.google.com/rss/search?q=site:economictimes.indiatimes.com+(Nifty+OR+Sensex+OR+market+OR+stock)&hl=en-IN&gl=IN&ceid=IN:en' },
  { name: 'LiveMint Markets', url: 'https://news.google.com/rss/search?q=site:livemint.com+(Nifty+OR+Sensex+OR+market+OR+shares)&hl=en-IN&gl=IN&ceid=IN:en' },
  { nseOfficial: true, name: 'NSE / SEBI Circulars', url: 'https://news.google.com/rss/search?q=("NSE+circular"+OR+"SEBI+circular"+OR+"NSE+announcement"+OR+"Nifty+50+rebalancing")&hl=en-IN&gl=IN&ceid=IN:en' },
  { name: 'Reuters Global/Macro', url: 'https://news.google.com/rss/search?q=(geopolitical+conflict+OR+"US+Fed"+OR+"crude+oil"+OR+"bond+yields"+OR+"tariffs")+source:Reuters&hl=en-US&gl=US&ceid=US:en' },
  { name: 'CNBC-TV18 India', url: 'https://news.google.com/rss/search?q=(Nifty+OR+Sensex+OR+RBI)+source:%22CNBC-TV18%22&hl=en-IN&gl=IN&ceid=IN:en' }
];

// Simple in-memory IP request tracker for rate limiting (max 40 requests per min per IP)
const ipRateCache = new Map<string, { count: number, resetTime: number }>();

export function rateLimitMiddleware(req: any, res: any, next: any) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const limitObj = ipRateCache.get(ip);

  if (!limitObj || now > limitObj.resetTime) {
    ipRateCache.set(ip, { count: 1, resetTime: now + 60 * 1000 });
    return next();
  }

  if (limitObj.count >= 40) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  limitObj.count++;
  next();
}

// Format Date into simple string representation in Asia/Kolkata timezone
function getKolkataDateString(date: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  } catch (err) {
    // Fallback if formatting fails
    return date.toISOString().split('T')[0];
  }
}

// Format IST published time
function formatISTTime(date: Date): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).format(date);
  } catch (err) {
    return date.toLocaleString();
  }
}

// Check if article fits keyword specifications and rate its relevance & details deterministic
const RELEVANT_TERMS = [
  'nifty', 'sensex', 'indian stock', 'stock market', 'rbi', 'repo rate',
  'inflation', 'interest rate', 'crude oil', 'usd/inr', 'usd-inr', 'rupee',
  'fii', 'dii', 'fpi', 'global market', 'us fed', 'interest rate', 'bond yield',
  'geopolit', 'war', 'conflict', 'tariff', 'india gdp', 'indian economy',
  'banking', 'it sector', 'pharma', 'automobile', 'auto sector', 'energy sector',
  'reliance', 'hdfc', 'tcs', 'infosys', 'icici', 'itc', 'l&t', 'sbi', 'tata',
  'adani', 'sebi', 'nse', 'bse', 'market bounce', 'record high', 'pms',
  'market crash', 'foreign institutional', 'us fed rate', 'fomc', 'treasury'
];

const EXCLUDED_TERMS = [
  'celebrity', 'bollywood', 'recipe', 'iphone', 'smartphone', 'cricket', 'ipl',
  'horoscope', 'astrology', 'movie', 'fashion', 'trailer', 'actors', 'actress',
  'pinkvilla', 'small-cap', 'micro-cap', 'penny stock', 'lifestyle', 'fitness',
  'gadget review', 'travel guide', 'dating app', 'gaming console', 'gossip'
];

interface CheckResult {
  matched: boolean;
  score: number;
  category: 'India Market' | 'Global Macro' | 'Geopolitical' | 'Sector' | 'NIFTY Companies';
  whyItMatters: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
}

function determineSentiment(title: string, description: string): 'bullish' | 'bearish' | 'neutral' {
  const combined = `${title} ${description}`.toLowerCase();
  
  const bearishTerms = [
    'crash', 'plunge', 'slump', 'drop', 'fall', 'decline', 'loss', 'weak', 'drag', 'low',
    'bearish', 'selling', 'outflow', 'net seller', 'hawkish', 'rate hike', 'escalat', 'war',
    'conflict', 'missile', 'tension', 'tariff', 'strike', 'inflation spike', 'crude spike', 
    'rupee slide', 'profit fall', 'deficit', 'slippage'
  ];

  const bullishTerms = [
    'bounce', 'rise', 'rally', 'surge', 'jump', 'gain', 'growth', 'up', 'all-time high',
    'record high', 'bullish', 'buying', 'inflow', 'net buyer', 'easing rate', 'dividend',
    'acquisition', 'merger', 'expansion', 'recover', 'beat earnings', 'profit rise'
  ];

  let bearishCount = 0;
  let bullishCount = 0;

  for (const term of bearishTerms) {
    if (combined.includes(term)) bearishCount++;
  }

  for (const term of bullishTerms) {
    if (combined.includes(term)) bullishCount++;
  }

  if (bearishCount > bullishCount) {
    return 'bearish';
  } else if (bullishCount > bearishCount) {
    return 'bullish';
  }
  return 'neutral';
}

function checkRelevanceAndGetScore(title: string, description: string): CheckResult {
  const combined = `${title} ${description}`.toLowerCase();

  // Exclude bad content immediately
  for (const term of EXCLUDED_TERMS) {
    if (combined.includes(term)) {
      return { matched: false, score: 0, category: 'India Market', whyItMatters: '', sentiment: 'neutral' };
    }
  }

  // Must match at least one relevant keyword
  let isRelevant = false;
  for (const term of RELEVANT_TERMS) {
    if (combined.includes(term)) {
      isRelevant = true;
      break;
    }
  }

  if (!isRelevant) {
    return { matched: false, score: 0, category: 'India Market', whyItMatters: '', sentiment: 'neutral' };
  }

  // Local rule-based impact scoring (0 - 100)
  let score = 50; // base score for matching relevant list
  const titleLower = title.toLowerCase();

  if (titleLower.includes('rbi') || titleLower.includes('repo rate') || titleLower.includes('reserve bank')) {
    score += 30;
  } else if (titleLower.includes('fed') || titleLower.includes('federal reserve') || titleLower.includes('fomc')) {
    score += 30;
  } else if (titleLower.includes('crude') || titleLower.includes('brent')) {
    score += 20;
  } else if (titleLower.includes('war') || titleLower.includes('missile') || titleLower.includes('geopolitical escalation') || titleLower.includes('conflict') || titleLower.includes('tariffs')) {
    score += 20;
  } else if (titleLower.includes('inflation') || titleLower.includes('cpi')) {
    score += 15;
  } else if (titleLower.includes('gdp')) {
    score += 15;
  } else if (titleLower.includes('fii') || titleLower.includes('dii') || titleLower.includes('foreign institutional')) {
    score += 15;
  } else if (titleLower.includes('reliance') || titleLower.includes('hdfc bank') || titleLower.includes('icici bank') || titleLower.includes('tcs') || titleLower.includes('infosys')) {
    score += 15;
  }

  // Bonus for volatile high-impact verbs/keywords in Title
  if (
    titleLower.includes('crash') || 
    titleLower.includes('plunge') || 
    titleLower.includes('spikes') || 
    titleLower.includes('surges') || 
    titleLower.includes('slumps') || 
    titleLower.includes('all-time high') || 
    titleLower.includes('record high') || 
    titleLower.includes('falls') || 
    titleLower.includes('jumps') || 
    titleLower.includes('panic')
  ) {
    score += 15;
  }

  score = Math.min(score, 100);

  // Categorize
  let category: 'India Market' | 'Global Macro' | 'Geopolitical' | 'Sector' | 'NIFTY Companies' = 'India Market';
  
  if (
    titleLower.includes('fed') || 
    titleLower.includes('treasury') || 
    titleLower.includes('global') || 
    titleLower.includes('macro') || 
    titleLower.includes('crude') || 
    titleLower.includes('yield')
  ) {
    category = 'Global Macro';
  } else if (
    titleLower.includes('war') || 
    titleLower.includes('conflict') || 
    titleLower.includes('missile') || 
    titleLower.includes('tension') || 
    titleLower.includes('geopolit') || 
    titleLower.includes('tariffs')
  ) {
    category = 'Geopolitical';
  } else if (
    titleLower.includes('reliance') || 
    titleLower.includes('hdfc') || 
    titleLower.includes('tcs') || 
    titleLower.includes('infosys') || 
    titleLower.includes('icici') || 
    titleLower.includes('itc') || 
    titleLower.includes('l&t') || 
    titleLower.includes('sbi') || 
    titleLower.includes('tata') || 
    titleLower.includes('adani')
  ) {
    category = 'NIFTY Companies';
  } else if (
    titleLower.includes('banking') || 
    titleLower.includes('financials') || 
    titleLower.includes('it sector') || 
    titleLower.includes('pharma') || 
    titleLower.includes('auto') || 
    titleLower.includes('energy') || 
    titleLower.includes('metals')
  ) {
    category = 'Sector';
  }

  // One-liner justification
  let whyItMatters = 'Key sectoral shifts or corporate actions within major companies shape benchmark earnings multiples and institutional portfolios.';
  
  if (titleLower.includes('rbi') || titleLower.includes('repo rate') || titleLower.includes('reserve bank')) {
    whyItMatters = 'RBI interest rate policies directly govern borrowing costs, commercial banking liquidity, and high-beta bank stock valuations.';
  } else if (titleLower.includes('fed') || titleLower.includes('federal reserve') || titleLower.includes('fomc')) {
    whyItMatters = 'Federal Reserve rate actions dictate global liquidity, currency markets, and FII flows to emerging markets like India.';
  } else if (titleLower.includes('crude') || titleLower.includes('brent')) {
    whyItMatters = 'Elevated crude oil prices increase fuel inflation and widen India\'s current account deficit, affecting consumer/auto stock sentiment.';
  } else if (titleLower.includes('usd/inr') || titleLower.includes('rupee') || titleLower.includes('usd-inr')) {
    whyItMatters = 'Rupee fluctuations alter export realizations for IT/Pharma sectors and change FII return formulas.';
  } else if (titleLower.includes('fii') || titleLower.includes('dii') || titleLower.includes('foreign institutional')) {
    whyItMatters = 'FII inflows or outflows represent critical institutional liquidity that directs the near-term momentum of Nifty index heavyweights.';
  } else if (titleLower.includes('geopolit') || titleLower.includes('war') || titleLower.includes('conflict') || titleLower.includes('middle east') || titleLower.includes('tariff')) {
    whyItMatters = 'Geopolitical conflicts alter energy supply corridors, commodity prices, and increase risk premium for emerging equity markets.';
  } else if (titleLower.includes('inflation') || titleLower.includes('cpi')) {
    whyItMatters = 'Consumer inflation dynamics dictate domestic interest rate rules and shape broader household consumer stock margins.';
  } else if (titleLower.includes('gdp')) {
    whyItMatters = 'Domestic GDP growth figures validate corporate earnings recovery, attracting foreign direct and institutional investments.';
  } else if (titleLower.includes('reliance')) {
    whyItMatters = 'As the highest-weighted stock in Nifty 50, Reliance moves serve as a major structural driver of index benchmark levels.';
  } else if (titleLower.includes('hdfc')) {
    whyItMatters = 'HDFC Bank carries massive weight in Nifty 50 and Bank Nifty; its price actions act as an anchor for financial benchmark indices.';
  } else if (titleLower.includes('it sector') || titleLower.includes('tcs') || titleLower.includes('infosys')) {
    whyItMatters = 'Nifty IT sector moves track US enterprise capital expenditure and global contracting updates, dictating index momentum.';
  } else if (titleLower.includes('banking') || titleLower.includes('financials') || titleLower.includes('banks')) {
    whyItMatters = 'Financial services are the largest sector block in Nifty 50; credit trends reflect systemic liquidity and domestic capital health.';
  } else if (category === 'India Market') {
    whyItMatters = 'Broad momentum and technical breakthroughs in Indian benchmarks signals local institutional flow dynamics & support.';
  } else if (category === 'Global Macro') {
    whyItMatters = 'International market triggers and foreign index futures set key sentiment expectations and guide gap-openings for local trade sessions.';
  }

  return {
    matched: true,
    score,
    category,
    whyItMatters,
    sentiment: determineSentiment(title, description)
  };
}

// Fetch a single feed safely with robust error handling and custom User-Agent
async function fetchFeed(name: string, url: string): Promise<any[]> {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      },
      timeout: 10000 // 10s timeout to avoid blocking
    });

    const parsed = await parser.parseString(response.data);
    return (parsed.items || []).map(item => ({
      title: item.title || '',
      link: item.link || '',
      pubDate: item.pubDate || item.isoDate || '',
      description: item.contentSnippet || item.content || '',
      source: name
    }));
  } catch (err: any) {
    console.error(`Status check: Failed to retrieve RSS feed [${name}]:`, err.message);
    return [];
  }
}

// Complete aggregate news retrieval, ranking, and enhancing flow
async function fetchAndProcessNewsFromSources(): Promise<NewsItem[]> {
  try {
    const fetchPromises = FEEDS.map(f => fetchFeed(f.name, f.url));
    const feedsResults = await Promise.all(fetchPromises);
    const rawArticles = feedsResults.flat();

    if (rawArticles.length === 0) {
      return [];
    }

    // Determine what today and yesterday date strings are in Asia/Kolkata
    const now = new Date();
    const todayKolkata = getKolkataDateString(now);
    const yesterdayKolkata = getKolkataDateString(new Date(now.getTime() - 24 * 60 * 60 * 1000));

    // Timezone-correct and duplicate filter candidates
    const filteredCandidates: any[] = [];
    const seenTitles = new Set<string>();
    const seenUrls = new Set<string>();

    for (const article of rawArticles) {
      if (!article.title) continue;

      const normTitle = article.title.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
      const normUrl = article.link.trim();

      if (seenTitles.has(normTitle) || seenUrls.has(normUrl)) {
        continue;
      }

      // Check article date limits
      const pubDate = article.pubDate;
      if (!pubDate) continue;

      const parsedDate = new Date(pubDate);
      if (isNaN(parsedDate.getTime())) continue;

      const artKolkataStr = getKolkataDateString(parsedDate);

      // We only accept articles from today and yesterday
      if (artKolkataStr !== todayKolkata && artKolkataStr !== yesterdayKolkata) {
        continue;
      }

      // Local relevance rating check
      const relation = checkRelevanceAndGetScore(article.title, article.description);
      if (!relation.matched) {
        continue;
      }

      seenTitles.add(normTitle);
      seenUrls.add(normUrl);

      filteredCandidates.push({
        ...article,
        parsedDate,
        category: relation.category,
        sentiment: relation.sentiment,
        impactScore: relation.score,
        whyItMatters: relation.whyItMatters
      });
    }

    if (filteredCandidates.length === 0) {
      return [];
    }

    // Sort by date dynamically
    filteredCandidates.sort((a, b) => b.parsedDate.getTime() - a.parsedDate.getTime());

    // Try premium Gemini API enhancer if key is available
    const ai = getAi();
    if (ai) {
      try {
        // Take top 20 candidates maximum to save tokens and ensure excellent throughput
        const geminiInputList = filteredCandidates.slice(0, 20).map(c => ({
          id: c.link, 
          headline: c.title,
          description: c.description,
          source: c.source,
          time: c.parsedDate.toISOString(),
          link: c.link
        }));

        const response = await ai.models.generateContent({
          model: 'gemini-3.5-flash',
          contents: `You are an expert Indian financial market advisor specializing in the NIFTY 50 and macroeconomic events.
Analyze the following candidate news articles published yesterday or today:

${JSON.stringify(geminiInputList)}

Instructions:
1. Re-evaluate relevance to NIFTY 50, Indian stock market, RBI policy, USD/INR, global macro indicators, and geopolitical developments. Exclude celebrity news, generic company PR, minor small-cap press releases, or repetitive stories.
2. Re-assign custom Market Impact Scores (0 to 100) according to these specifications:
   - RBI or US Fed interest rate decisions, major inflation spikes, major geopolitical breakouts: 85-100 (high impact)
   - Indian economic indices (GDP, inflation), major sector policy updates, FII/DII long stance shifts, major Nifty heavyweight Q/A earnings (HDFC Bank, Reliance, TCS, Infosys): 75-85 (medium-high impact)
   - Minor sector stories, trade indicators, routine stock coverage: 50-70.
3. Exclude any items with an final impactScore < 60.
4. Deduplicate items. 
5. Compose a highly accurate, custom, actionable ONE-LINE rationale explaining exactly "Why this matters for NIFTY" ('whyItMatters') pointing out sectors, weights or liquidity impacts. Keep it under 150 characters.
6. Return a maximum of 10 articles, sorted by impactScore in descending order. Prefer 5-7 highest quality items.
7. Return exactly one of these five categories for 'category': 'India Market', 'Global Macro', 'Geopolitical', 'Sector', 'NIFTY Companies'. For 'timeIST', convert the provided 'time' (ISO format) into Indian Standard Time formatted like "30 May, 07:20 PM" (using the appropriate date and time).
8. Determine whether the news is 'bullish', 'bearish', or 'neutral' for the Nifty/Indian market trends, and return it as 'sentiment'.

Your output MUST be a valid JSON array complying strictly with the requested structure. Do not include markdown code block formatting except valid json output.`,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  headline: { type: Type.STRING },
                  source: { type: Type.STRING },
                  time: { type: Type.STRING },
                  timeIST: { type: Type.STRING },
                  category: { type: Type.STRING },
                  sentiment: { type: Type.STRING, description: "Must be exactly 'bullish' | 'bearish' | 'neutral'" },
                  impactScore: { type: Type.INTEGER },
                  whyItMatters: { type: Type.STRING },
                  link: { type: Type.STRING }
                },
                required: ['id', 'headline', 'source', 'time', 'timeIST', 'category', 'sentiment', 'impactScore', 'whyItMatters', 'link']
              }
            }
          }
        });

        const textResponse = response.text?.trim() || "";
        const parsedItems = JSON.parse(textResponse) as NewsItem[];
        
        if (Array.isArray(parsedItems) && parsedItems.length > 0) {
          // Double check validity and clamp max list length to 10
          const finalItems = parsedItems
            .filter(item => item.impactScore >= 60 && ['India Market', 'Global Macro', 'Geopolitical', 'Sector', 'NIFTY Companies'].includes(item.category) && ['bullish', 'bearish', 'neutral'].includes(item.sentiment))
            .slice(0, 10);

          currentAIStatus = {
            success: true,
            lastSuccessTime: new Date().toISOString(),
            fallbackReason: null,
            geminiCount: finalItems.length,
            localCount: 0
          };

          return finalItems;
        } else {
          throw new Error("No valid JSON array output returned from Gemini processor");
        }
      } catch (geminiErr: any) {
        console.log("[News Service] Using local analyzer (Gemini unavailable)");
        currentAIStatus.success = false;
        currentAIStatus.fallbackReason = geminiErr?.message || "Rate-limited or model execution failure";
      }
    } else {
      currentAIStatus.success = false;
      currentAIStatus.fallbackReason = "GEMINI_API_KEY environment variable is missing";
    }

    // Fallback: fully rule-based, deterministic analysis
    const formattedLocalItems: NewsItem[] = filteredCandidates
      .filter(c => c.impactScore >= 60)
      .slice(0, 10)
      .map((c, idx) => ({
        id: c.link || `local-${idx}-${Date.now()}`,
        headline: c.title,
        source: c.source,
        time: c.parsedDate.toISOString(),
        timeIST: formatISTTime(c.parsedDate),
        category: c.category,
        sentiment: c.sentiment,
        impactScore: c.impactScore,
        whyItMatters: c.whyItMatters,
        link: c.link
      }));

    currentAIStatus.geminiCount = 0;
    currentAIStatus.localCount = formattedLocalItems.length;

    return formattedLocalItems;

  } catch (err: any) {
    console.error("Critical failure during news aggregation service:", err);
    return [];
  }
}

// Primary endpoint fetching helper with caching & locks
export async function getLiveNews(): Promise<NewsItem[]> {
  const now = Date.now();

  // If cached and still valid, return cache
  if (cachedNews.length > 0 && (now - lastFetchedTime < CACHE_DURATION)) {
    return cachedNews;
  }

  // If background task is already executing, reuse it
  if (activeFetchPromise) {
    return activeFetchPromise;
  }

  // Launch refresh
  activeFetchPromise = fetchAndProcessNewsFromSources()
    .then(freshNews => {
      activeFetchPromise = null;
      if (freshNews && freshNews.length > 0) {
        cachedNews = freshNews;
        lastFetchedTime = Date.now();
      }
      return cachedNews;
    })
    .catch(err => {
      activeFetchPromise = null;
      console.error("Resetting fetch promise after error:", err);
      return cachedNews; // Fallback to cache even if stale on error
    });

  return activeFetchPromise;
}
