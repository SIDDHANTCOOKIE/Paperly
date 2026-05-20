// ================================
// Paperly Backend — Multi-Provider
// ================================

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '..', '.env') });

const app = express();
const PORT = process.env.PORT || 3001;
const FREE_LIMIT_PER_HOUR = Number(process.env.FREE_LIMIT_PER_HOUR || 3);
const PREMIUM_LIMIT_PER_HOUR = Number(process.env.PREMIUM_LIMIT_PER_HOUR || 30);
const PREMIUM_DAYS = Number(process.env.PREMIUM_DAYS || 30);
const PREMIUM_TOKEN_SECRET = process.env.PREMIUM_TOKEN_SECRET || 'change-this-premium-token-secret';
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const USD_TO_INR_RATE = Number(process.env.USD_TO_INR_RATE || 85);
const SPONSOR_MIN_USD = Number(process.env.SPONSOR_MIN_USD || 2);
const SPONSOR_MAX_USD = Number(process.env.SPONSOR_MAX_USD || 500);

// Trust the first proxy (Render load balancer) so req.ip is correct
app.set('trust proxy', 1);

// CORS must be first!
app.use(cors({
    origin: '*', // Allow any frontend (Vercel, localhost, etc.)
    credentials: false, // No cookies used, so this is safe/easier
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

function getBearerToken(req) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return '';
    return auth.slice('Bearer '.length).trim();
}

function signPremiumPayload(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', PREMIUM_TOKEN_SECRET).update(encoded).digest('base64url');
    return `${encoded}.${sig}`;
}

function verifyPremiumToken(token) {
    if (!token || !token.includes('.')) return null;
    const [encoded, providedSig] = token.split('.');
    if (!encoded || !providedSig) return null;

    const expectedSig = crypto.createHmac('sha256', PREMIUM_TOKEN_SECRET).update(encoded).digest('base64url');
    const safeProvided = Buffer.from(providedSig);
    const safeExpected = Buffer.from(expectedSig);
    if (safeProvided.length !== safeExpected.length) return null;
    if (!crypto.timingSafeEqual(safeProvided, safeExpected)) return null;

    try {
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (!payload.exp || Number(payload.exp) < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch {
        return null;
    }
}

function getPremiumClaims(req) {
    return verifyPremiumToken(getBearerToken(req));
}

function isPremiumRequest(req) {
    return Boolean(getPremiumClaims(req));
}

function hasRazorpayConfig() {
    return Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
}

function usdToPaise(usdAmount) {
    return Math.round(usdAmount * USD_TO_INR_RATE * 100);
}

function parseAmount(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
}

// Rate limiting: dynamic for free vs premium
const limiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    limit: (req) => (isPremiumRequest(req) ? PREMIUM_LIMIT_PER_HOUR : FREE_LIMIT_PER_HOUR),
    keyGenerator: (req) => {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        const tier = isPremiumRequest(req) ? 'premium' : 'free';
        return `${tier}:${ip}`;
    },
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: (req) => ({
        error: isPremiumRequest(req)
            ? `Premium rate limit exceeded. You can analyze ${PREMIUM_LIMIT_PER_HOUR} papers per hour.`
            : `Free rate limit exceeded. You can analyze ${FREE_LIMIT_PER_HOUR} papers per hour.`,
    }),
});

// Apply rate limiting only to analysis endpoints (not health, premium status, payments)
app.use('/api/summarize', limiter);
app.use('/api/explain', limiter);
app.use('/api/notebook', limiter);

app.use(express.json({ limit: '50mb' }));

// Serve frontend in production
const distPath = join(__dirname, '..', 'dist');
app.use(express.static(distPath));

// ── Provider Setup ─────────────────────────────────────

const providers = [];

// Generic factory for any OpenAI-compatible API
function makeProvider(baseUrl, apiKey, model, label) {
    return {
        name: label,
        call: async (prompt, sys) => {
            const messages = [];
            if (sys) messages.push({ role: 'system', content: sys });
            messages.push({ role: 'user', content: prompt });

            const res = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    messages,
                    temperature: 0.7,
                    max_tokens: 8192,
                }),
            });

            if (!res.ok) {
                const err = await res.text();
                throw new Error(`${label} ${res.status}: ${err}`);
            }
            const data = await res.json();
            let content = data.choices[0].message.content;
            // Strip <think>...</think> tags from reasoning models
            content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            return content;
        },
    };
}

// 1. Groq — supports multiple comma-separated keys for rotation
const groqKeys = (process.env.GROQ_API_KEY || '')
    .split(/[\s*,]+/)
    .map((k) => k.trim())
    .filter(Boolean);

groqKeys.forEach((key, i) => {
    const tag = groqKeys.length > 1 ? ` #${i + 1}` : '';
    providers.push(makeProvider(
        'https://api.groq.com/openai/v1',
        key, 'llama-3.3-70b-versatile', `Groq 70b${tag}`
    ));
    providers.push(makeProvider(
        'https://api.groq.com/openai/v1',
        key, 'llama-3.1-8b-instant', `Groq 8b-instant${tag}`
    ));
});

// 2. Cerebras — 14,400 req/day free, extremely fast
if (process.env.CEREBRAS_API_KEY) {
    providers.push(makeProvider(
        'https://api.cerebras.ai/v1',
        process.env.CEREBRAS_API_KEY, 'llama-3.3-70b', 'Cerebras 70b'
    ));
}

// 3. SambaNova — free Llama access
if (process.env.SAMBANOVA_API_KEY) {
    providers.push(makeProvider(
        'https://api.sambanova.ai/v1',
        process.env.SAMBANOVA_API_KEY, 'Meta-Llama-3.1-70B-Instruct', 'SambaNova 70b'
    ));
}

// 4. Google Gemini — Free tier offers great limits (15 RPM, 1M TPM, 1500 RPD)
if (process.env.GEMINI_API_KEY) {
    providers.push(makeProvider(
        'https://generativelanguage.googleapis.com/v1beta/openai',
        process.env.GEMINI_API_KEY, 'gemini-2.0-flash', 'Gemini 2.0 Flash'
    ));
}

// 5. OpenRouter — Fallback free & large models
if (process.env.OPENROUTER_API_KEY) {
    providers.push(makeProvider(
        'https://openrouter.ai/api/v1',
        process.env.OPENROUTER_API_KEY, 'deepseek/deepseek-v4-flash:free', 'OpenRouter DeepSeek v4 Flash'
    ));
    providers.push(makeProvider(
        'https://openrouter.ai/api/v1',
        process.env.OPENROUTER_API_KEY, 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', 'OpenRouter Dolphin Mistral 24B'
    ));
    providers.push(makeProvider(
        'https://openrouter.ai/api/v1',
        process.env.OPENROUTER_API_KEY, 'meta-llama/llama-3.3-70b-instruct', 'OpenRouter Llama 3.3 70B'
    ));
}

if (providers.length === 0) {
    console.error('❌ No API keys found in .env — need at least GROQ_API_KEY or GEMINI_API_KEY');
    process.exit(1);
}

console.log(`  ✦ Providers loaded: ${providers.map((p) => p.name).join(' → ')}`);

// ── Smart Caller — fast failover ───────────────────────

async function callAI(prompt, systemInstruction = '') {
    const errors = [];
    let allRateLimited = true;

    for (const prov of providers) {
        try {
            const result = await prov.call(prompt, systemInstruction);
            console.log(`  ✓ ${prov.name}`);
            return result;
        } catch (err) {
            const msg = err.message || '';
            const isRate = msg.includes('429') || msg.includes('quota') || msg.includes('rate') || msg.includes('Too Many') || msg.includes('limit');
            const is404 = msg.includes('404');

            if (!isRate && !is404) allRateLimited = false;
            errors.push(`${prov.name}: ${msg.slice(0, 120)}`);
            console.log(`  ✕ ${prov.name}: ${msg.slice(0, 80)}`);

            // Only do a short wait + retry on the LAST provider if rate-limited
            if (isRate && prov === providers[providers.length - 1]) {
                console.log(`  ⏳ Last provider rate-limited, waiting 15s…`);
                await new Promise((r) => setTimeout(r, 15000));
                try {
                    const result = await prov.call(prompt, systemInstruction);
                    console.log(`  ✓ ${prov.name} (retry)`);
                    return result;
                } catch (retryErr) {
                    errors.push(`${prov.name} (retry): ${(retryErr.message || '').slice(0, 120)}`);
                }
            }
        }
    }

    const error = new Error(`All providers failed:\n${errors.join('\n')}`);
    error.allRateLimited = allRateLimited;
    throw error;
}

// ── Helper ─────────────────────────────────────────────

function truncateText(text, maxChars = 25000) {
    if (text.length <= maxChars) return text;
    const t = text.substring(0, maxChars);
    const sp = t.lastIndexOf(' ');
    return t.substring(0, sp) + '\n\n[…truncated]';
}

// ── Routes ─────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
    res.json({
        status: 'ok',
        providers: providers.map((p) => p.name),
        paymentsEnabled: hasRazorpayConfig(),
        minSponsorUsd: SPONSOR_MIN_USD,
    });
});

app.get('/api/premium/status', (req, res) => {
    const claims = getPremiumClaims(req);
    if (!claims) return res.status(401).json({ active: false });
    res.json({
        active: true,
        expiresAt: Number(claims.exp) * 1000,
        plan: claims.plan || 'sponsor-premium',
    });
});

app.post('/api/payments/create-order', async (req, res) => {
    try {
        if (!hasRazorpayConfig()) {
            return res.status(503).json({ error: 'Payments are not configured on the server.' });
        }

        const sponsorName = String(req.body?.sponsorName || 'Sponsor').trim().slice(0, 80);
        const sponsorEmail = String(req.body?.sponsorEmail || '').trim().slice(0, 120);
        const amountUsd = parseAmount(req.body?.amountUsd);

        if (!Number.isFinite(amountUsd)) {
            return res.status(400).json({ error: 'amountUsd must be a valid number.' });
        }
        if (amountUsd < SPONSOR_MIN_USD) {
            return res.status(400).json({ error: `Minimum sponsorship is $${SPONSOR_MIN_USD}.` });
        }
        if (amountUsd > SPONSOR_MAX_USD) {
            return res.status(400).json({ error: `Maximum sponsorship is $${SPONSOR_MAX_USD}.` });
        }

        const amountPaise = usdToPaise(amountUsd);
        const receipt = `paperly_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        const response = await fetch('https://api.razorpay.com/v1/orders', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64')}`,
            },
            body: JSON.stringify({
                amount: amountPaise,
                currency: 'INR',
                receipt,
                notes: {
                    sponsorName,
                    sponsorEmail,
                    usdAmount: amountUsd.toFixed(2),
                    product: 'Paperly Sponsor Premium',
                },
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Razorpay ${response.status}: ${text}`);
        }

        const order = await response.json();
        return res.json({
            keyId: RAZORPAY_KEY_ID,
            orderId: order.id,
            amountPaise,
            amountUsd: amountUsd.toFixed(2),
            amountInr: (amountPaise / 100).toFixed(2),
            premiumDays: PREMIUM_DAYS,
            minSponsorUsd: SPONSOR_MIN_USD,
        });
    } catch (err) {
        console.error('Create order error:', err.message);
        return res.status(500).json({ error: 'Could not create payment order.' });
    }
});

app.post('/api/payments/verify', (req, res) => {
    try {
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            sponsorEmail,
            amountUsd,
        } = req.body || {};

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Missing payment verification fields.' });
        }

        const expected = crypto
            .createHmac('sha256', RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');

        if (expected !== razorpay_signature) {
            return res.status(400).json({ error: 'Payment signature verification failed.' });
        }

        const paidAmount = parseAmount(amountUsd);
        const normalizedAmount = Number.isFinite(paidAmount) ? Number(paidAmount.toFixed(2)) : SPONSOR_MIN_USD;

        const issuedAt = Math.floor(Date.now() / 1000);
        const expiresAt = issuedAt + PREMIUM_DAYS * 24 * 60 * 60;
        const premiumToken = signPremiumPayload({
            plan: 'sponsor-premium',
            iat: issuedAt,
            exp: expiresAt,
            paymentId: razorpay_payment_id,
            orderId: razorpay_order_id,
            amountUsd: normalizedAmount,
            email: String(sponsorEmail || '').trim().slice(0, 120),
        });

        return res.json({
            ok: true,
            premiumToken,
            plan: 'sponsor-premium',
            expiresAt: expiresAt * 1000,
            premiumDays: PREMIUM_DAYS,
        });
    } catch (err) {
        console.error('Verify payment error:', err.message);
        return res.status(500).json({ error: 'Failed to verify payment.' });
    }
});

app.post('/api/summarize', async (req, res) => {
    try {
        const { paperText } = req.body;
        if (!paperText) return res.status(400).json({ error: 'paperText is required' });

        const sys = `You are an expert research paper analyzer. Produce a clear, structured summary using markdown.`;

        const prompt = `Analyze the following research paper and provide a structured summary with these sections:

## Paper Overview
- Title (infer from content)
- Authors (if identifiable)
- One-line summary

## Problem Statement
What specific problem does this paper address? Why does it matter?

## Key Contributions
List the main contributions (3-5 bullet points)

## Core Method
Describe the proposed approach. What are the key ideas?

## Assumptions & Limitations
What assumptions does the paper make?

## Experimental Setup
What experiments were run? Datasets/benchmarks?

## Main Results
Key findings. How does it compare to baselines?

## Connections
How does this relate to prior work? Future directions?

---

PAPER TEXT:
${truncateText(paperText)}`;

        const result = await callAI(prompt, sys);
        res.json({ result });
    } catch (err) {
        console.error('Summarize error:', err.message);
        if (err.allRateLimited) {
            return res.status(429).json({ error: 'All AI providers are currently rate-limited. Please wait a minute and try again.', rateLimited: true, retryAfter: 30 });
        }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/explain', async (req, res) => {
    try {
        const { paperText } = req.body;
        if (!paperText) return res.status(400).json({ error: 'paperText is required' });

        const sys = `You are a brilliant teacher who makes complex research accessible. Use analogies, intuition, and clear language. Avoid jargon unless you explain it. Use markdown.`;

        const prompt = `Read this research paper and create a comprehensive, intuitive explanation:

## The Big Picture
Start with a real-world analogy or motivation.

## The Problem, Simply Put
Explain the core problem without jargon.

## The Solution — Step by Step
Walk through the method step by step. For each:
- What it does
- Why it's needed
- Intuition behind it

## Understanding the Math
For each major equation:
- Write it out
- Explain each symbol
- Provide intuition
- Give a concrete example

## What Makes This Clever?
The key insight or "aha moment."

## Limitations
Assumptions? Where might it break?

## Key Takeaways
3-5 bullet points summarizing the most important things.

---

PAPER TEXT:
${truncateText(paperText)}`;

        const result = await callAI(prompt, sys);
        res.json({ result });
    } catch (err) {
        console.error('Explain error:', err.message);
        if (err.allRateLimited) {
            return res.status(429).json({ error: 'All AI providers are currently rate-limited. Please wait a minute and try again.', rateLimited: true, retryAfter: 30 });
        }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/notebook', async (req, res) => {
    try {
        const { paperText } = req.body;
        if (!paperText) return res.status(400).json({ error: 'paperText is required' });

        const sys = `You are an expert Python developer, educator, and research engineer. You create educational notebooks that teach readers the paper's ideas step by step. Every markdown cell must be a rich, multi-paragraph explanation — never just a heading. Your code must run without errors.`;

        const prompt = `Based on this research paper, generate a complete Google Colab notebook as valid JSON in .ipynb format.

CRITICAL — MARKDOWN CELL RULES:
Every markdown cell MUST contain AT LEAST 3–5 sentences of substantive explanation.
- Start with a heading (## or ###)
- Then explain the CONCEPT: what idea from the paper is being explored and why it matters
- Explain the THEORY: the math, logic, or intuition behind the concept in simple terms
- Explain what the CODE BELOW will do: what it implements, what to expect as output
- Use analogies, examples, or "think of it like..." phrasing for complex ideas
- NEVER have a markdown cell that is just a heading or one-liner

RULES:
1. Output ONLY the JSON wrapped in \`\`\`json code block
2. Valid .ipynb format with nbformat: 4, nbformat_minor: 5
3. Alternate between RICH MARKDOWN cells and CODE cells
4. Each code cell must run without errors in Google Colab
5. Use standard Colab packages: numpy, pandas, matplotlib, scipy, sklearn, torch
6. Include comments in code explaining each step
7. Include visualizations (plots, charts) where appropriate
8. Each code cell should be 5–25 lines, focused on ONE concept

STRUCTURE:
1. Title & Introduction (markdown: paper title, authors, what the paper proposes, why it matters, what this notebook covers — at least 2 paragraphs)
2. Setup & Imports (code)
3. For EACH major concept from the paper:
   a. Explanation (markdown: 3–5 sentences on the concept, the theory, the intuition, what we'll implement)
   b. Implementation (code: focused, commented, 5–25 lines)
   c. Result/visualization (code: show output, plot, or demonstration)
4. Experiments & Comparisons (markdown explaining what we're testing + code)
5. CONCLUSION (MANDATORY — this MUST be the very LAST cell):
   - Cell type: markdown
   - Title: "## Conclusion & Key Takeaways"
   - Content: 2–3 paragraphs summarizing what we learned, the key results, main insights from the paper
   - Include a bullet list of 4–6 key takeaways
   - End with "Things to try next" suggestions for further exploration

PAPER TEXT:
${truncateText(paperText, 20000)}

Output ONLY the valid .ipynb JSON in \`\`\`json blocks.`;

        const result = await callAI(prompt, sys);
        res.json({ result });
    } catch (err) {
        console.error('Notebook error:', err.message);
        if (err.allRateLimited) {
            return res.status(429).json({ error: 'All AI providers are currently rate-limited. Please wait a minute and try again.', rateLimited: true, retryAfter: 30 });
        }
        res.status(500).json({ error: err.message });
    }
});

// ── Start ──────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n  ✦  Paperly API → http://localhost:${PORT}`);
    console.log(`  ✦  Chain: ${providers.map((p) => p.name).join(' → ')}\n`);
});
