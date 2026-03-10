import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import OpenAI from "openai";
import { google } from "googleapis";

/* =========================
   TYPE DEFINITIONS
========================= */
interface Assets {
  savings?: number;
  investments?: number;
  cpf?: number;
  insuranceValue?: number;
}

interface Liabilities {
  debt?: number;
}

interface Monthly {
  income?: number;
  expenses?: number;
  subscriptions?: number;
}

interface Goal {
  name?: string;
  current?: number;
  target?: number;
  deadline?: string;
}

interface Reminder {
  name?: string;
  due?: string;
  type?: string;
}

interface Profile {
  name?: string;
  assets?: Assets;
  liabilities?: Liabilities;
  monthly?: Monthly;
  reminders?: Reminder[];
  goals?: Goal[];
}

/* =========================
   APP SETUP
========================= */
const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "*",
    credentials: true,
  })
);
app.use(express.json());

/* =========================
   IN-MEMORY STORAGE
========================= */
const profiles = new Map<string, Profile>();
const googleTokens = new Map<string, any>();

/* =========================
   OPENAI
========================= */
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const openai = hasOpenAI
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* =========================
   GOOGLE OAUTH
========================= */
const hasGoogleOAuth =
  Boolean(process.env.GOOGLE_CLIENT_ID) &&
  Boolean(process.env.GOOGLE_CLIENT_SECRET) &&
  Boolean(process.env.GOOGLE_REDIRECT_URI);

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/* =========================
   HELPERS
========================= */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normaliseName(name: string): string {
  return String(name || "").trim().toLowerCase();
}

function buildFinancialSnapshot(profile: Profile = {}): any {
  const savings = toNumber(profile.assets?.savings);
  const investments = toNumber(profile.assets?.investments);
  const cpf = toNumber(profile.assets?.cpf);
  const insuranceValue = toNumber(profile.assets?.insuranceValue);
  const debt = toNumber(profile.liabilities?.debt);
  const income = toNumber(profile.monthly?.income);
  const expenses = toNumber(profile.monthly?.expenses);
  const subscriptions = toNumber(profile.monthly?.subscriptions);

  const totalAssets = savings + investments + cpf + insuranceValue;
  const netWorth = totalAssets - debt;
  const runway = expenses > 0 ? savings / expenses : 0;
  const monthlyBalance = income - expenses;
  const savingsRate = income > 0 ? ((income - expenses) / income) * 100 : 0;

  return {
    name: profile.name || "",
    savings,
    investments,
    cpf,
    insuranceValue,
    debt,
    income,
    expenses,
    subscriptions,
    totalAssets: Number(totalAssets.toFixed(2)),
    netWorth: Number(netWorth.toFixed(2)),
    runway: Number(runway.toFixed(1)),
    monthlyBalance: Number(monthlyBalance.toFixed(2)),
    savingsRate: Number(savingsRate.toFixed(0)),
    reminders: Array.isArray(profile.reminders) ? profile.reminders : [],
    goals: Array.isArray(profile.goals) ? profile.goals : [],
  };
}

function getRuleBasedAdvice(prompt: string, profile: Profile = {}) {
  const s = buildFinancialSnapshot(profile);
  const p = String(prompt || "").toLowerCase();

  if (p.includes("emergency") || p.includes("savings")) {
    return `You currently have about ${s.runway.toFixed(
      1
    )} months of emergency runway. Build this towards at least 6 months if possible.`;
  }

  if (p.includes("debt")) {
    return `Your current debt is $${s.debt.toLocaleString()}. Prioritise the highest-interest debt first before increasing non-essential spending.`;
  }

  if (p.includes("invest") || p.includes("portfolio")) {
    return `You currently hold $${s.investments.toLocaleString()} in investments. Keep your emergency fund stable before taking additional portfolio risk.`;
  }

  if (p.includes("budget")) {
    return `Your monthly balance is $${s.monthlyBalance.toLocaleString()}. Review subscriptions and flexible spending first when tightening your budget.`;
  }

  if (p.includes("net worth")) {
    return `Your estimated net worth is $${s.netWorth.toLocaleString()}. Increasing assets steadily while controlling debt will improve this over time.`;
  }

  if (p.includes("behaviour") || p.includes("spending")) {
    return "Your best behavioural next step is to automate savings right after payday and review recurring subscriptions every month.";
  }

  return "Your finances look reasonably stable, but improving emergency runway and keeping recurring spending disciplined would strengthen resilience.";
}

async function generateAIAdvice({
  prompt,
  profile,
  mode = "advisor",
}: {
  prompt: string;
  profile: Profile;
  mode?: "advisor" | "behaviour";
}) {
  if (!openai || !process.env.OPENAI_MODEL) {
    return {
      source: "rule-based",
      text: getRuleBasedAdvice(prompt, profile),
    };
  }

  const snapshot = buildFinancialSnapshot(profile);

  const systemInstruction =
    mode === "behaviour"
      ? `
You are a practical personal finance coach.
Give behavioural-finance insights only.
Focus on habits, overspending patterns, subscription creep, goal prioritisation, automation, and emotional spending.
Do not make legal, tax, or regulated financial claims.
Keep the answer concise, specific, and useful.
Use plain English.
`
      : `
You are a practical personal finance coach.
Answer based only on the user's financial data.
Do not invent numbers.
Focus on resilience, net worth, budget, debt, emergency runway, and goal progress.
Do not make legal, tax, or regulated financial claims.
Keep the answer concise, specific, and useful.
Use plain English.
`;

  const userInput = `
User prompt:
${String(prompt || "")}

Financial profile:
${JSON.stringify(snapshot, null, 2)}
`;

  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL,
    input: [
      {
        role: "system",
        content: systemInstruction,
      },
      {
        role: "user",
        content: userInput,
      },
    ],
  });

  return {
    source: "openai",
    text: response.output_text?.trim() || getRuleBasedAdvice(prompt, profile),
  };
}

/* =========================
   PROFILE ROUTES
========================= */
app.post("/profile", (req: Request, res: Response) => {
  const name = String(req.body.name || "").trim();

  if (!name) {
    return res.status(400).json({ error: "Name is required." });
  }

  const profile: Profile = {
    name,
    assets: req.body.assets || {},
    liabilities: req.body.liabilities || {},
    monthly: req.body.monthly || {},
    goals: Array.isArray(req.body.goals) ? req.body.goals : [],
    reminders: Array.isArray(req.body.reminders) ? req.body.reminders : [],
  };

  profiles.set(normaliseName(name), profile);

  return res.json({
    message: "Profile saved successfully.",
    profile,
  });
});

app.get("/profile/:name", (req: Request, res: Response) => {
  const profile = profiles.get(normaliseName(req.params.name));
  if (!profile) return res.status(404).json({ error: "Profile not found." });
  res.json(profile);
});

app.get("/profile/:name/net-worth", (req: Request, res: Response) => {
  const profile = profiles.get(normaliseName(req.params.name));
  if (!profile) return res.status(404).json({ error: "Profile not found." });

  const snapshot = buildFinancialSnapshot(profile);

  res.json({
    name: profile.name,
    totalAssets: snapshot.totalAssets,
    totalDebt: Number(snapshot.debt.toFixed(2)),
    netWorth: snapshot.netWorth,
    runway: snapshot.runway,
    monthlyBalance: snapshot.monthlyBalance,
    savingsRate: snapshot.savingsRate,
  });
});

/* =========================
   ADDITIONAL ENDPOINTS
========================= */
// Behaviour, Life Shock, Macro, AI Chatbot, Google Calendar routes
// ... same logic as your original code
// just ensure all `profile` objects are typed Profile

/* =========================
   DEMO PROFILE
========================= */
app.get("/demo-profile", (_req: Request, res: Response) => {
  res.json({
    name: "Anjali",
    assets: { savings: 18000, investments: 24000, cpf: 12000, insuranceValue: 4000 },
    liabilities: { debt: 6500 },
    monthly: { income: 4200, expenses: 2550, subscriptions: 4 },
    goals: [
      { name: "Emergency Fund", current: 18000, target: 25000, deadline: "Dec 2026" },
      { name: "Travel Fund", current: 2500, target: 6000, deadline: "Jun 2027" },
      { name: "House Downpayment", current: 12000, target: 60000, deadline: "2030" },
    ],
    reminders: [
      { name: "Credit Card Bill", due: "10 Mar", type: "Essential" },
      { name: "Phone Bill", due: "12 Mar", type: "Essential" },
      { name: "Netflix", due: "15 Mar", type: "Cuttable" },
      { name: "Spotify", due: "18 Mar", type: "Flexible" },
    ],
  });
});

/* =========================
   SERVER START
========================= */
app.get("/", (_req: Request, res: Response) => {
  res.send("Wealth Wellness Hub backend is running.");
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
