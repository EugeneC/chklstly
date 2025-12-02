import express from 'express';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
app.use(express.json());


// Initialize OpenAI client for OpenRouter
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": process.env.SITE_URL,
    "X-Title": process.env.SITE_NAME,
    "Content-Type": "application/json"
  },
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.post('/trial', async (req, res) => {
  const { accessToken } = req.body;

  if (!accessToken) return res.status(400).json({ error: 'No accessToken provided' });

  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !user) {
      console.error('Auth error:', authError);
      return res.status(401).json({ error: 'Invalid token' });
    }

    const uid = user.id;
    const metadata = user.app_metadata || {};

    if (metadata.trialExpireDate != null) {
      return res.status(400).json({ error: 'Trial already set' });
    }

    const createdAtMs = new Date(user.created_at).getTime();
    const trialExpireDate = createdAtMs + 7 * 24 * 60 * 60 * 1000; // +7 days

    const { error: updateError } = await supabase.auth.admin.updateUserById(uid, {
      app_metadata: {
        ...metadata,
        trialExpireDate,
        hasPremium: metadata.hasPremium ?? false,
      },
    });

    if (updateError) {
      console.error('Supabase update error:', updateError);
      return res.status(500).json({ error: 'Failed to update trial data' });
    }

    res.json({ success: true, trialExpireDate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to set trial' });
  }
});

app.post('/premium', async (req, res) => {
  const { accessToken } = req.body;
  if (!accessToken) return res.status(400).json({ error: 'No accessToken provided' });

  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const uid = user.id;
    const metadata = user.app_metadata || {};
    const userEmail = user.email;

    if (metadata.hasPremium === true) {
      return res.status(400).json({ error: 'Premium already set' });
    }

    let hasPremium = false;
    if (skipEmails.includes(userEmail?.toLowerCase())) {
      hasPremium = true;
    } else {
      const adaptyResponse = await fetch(`https://api.adapty.io/api/v2/server-side-api/profile/`, {
        method: 'GET',
        headers: {
          'Authorization': `Api-Key ${process.env.ADAPTY_API_KEY}`,
          'Content-Type': 'application/json',
          'adapty-customer-user-id': uid,
        },
      });

      if (!adaptyResponse.ok) {
        const errText = await adaptyResponse.text();
        console.error('Adapty error:', errText);
        return res.status(500).json({ error: 'Failed to fetch subscription from Adapty' });
      }

      const adaptyData = await adaptyResponse.json();
      hasPremium = hasActiveSubscription(adaptyData);
    }

    if (hasPremium) {
      const { error: updateError } = await supabase.auth.admin.updateUserById(uid, {
        app_metadata: {
          ...metadata,
          hasPremium: true,
          trialExpireDate: metadata.trialExpireDate ?? null,
        },
      });

      if (updateError) {
        return res.status(500).json({ error: 'Failed to update premium status' });
      }
    }

    res.json({ success: true, hasPremium });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update premium status' });
  }
});


app.put('/premium', async (req, res) => {
  const { accessToken } = req.body;

  if (!accessToken) return res.status(400).json({ error: 'No accessToken provided' });

  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !user) {
      console.error('Auth error:', authError);
      return res.status(401).json({ error: 'Invalid token' });
    }

    const uid = user.id;
    const metadata = user.app_metadata || {};
    const userEmail = user.email;
    const now = Date.now();

    if (!metadata.hasPremium) {
      return res.json({ skipped: true, reason: 'No hasPremium metadata' });
    }

    // Check in last 24hours
    if (metadata.lastSubscriptionCheck && now - metadata.lastSubscriptionCheck < 24 * 60 * 60 * 1000) {
      return res.json({ skipped: true, reason: 'Checked less than 24h ago' });
    }

    // Skip e-mail
    const skipEmails = (process.env.SKIP_ADAPTY_EMAILS || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);

    let hasPremium = false;

    if (skipEmails.includes(userEmail?.toLowerCase())) {
      hasPremium = true;
    } else {
      // Check status through Adapty
      const adaptyResponse = await fetch(`https://api.adapty.io/api/v2/server-side-api/profile/`, {
        method: 'GET',
        headers: {
          'Authorization': `Api-Key ${process.env.ADAPTY_API_KEY}`,
          'Content-Type': 'application/json',
          'adapty-customer-user-id': uid,
        },
      });

      if (!adaptyResponse.ok) {
        hasPremium = false;
      } else {
        const adaptyData = await adaptyResponse.json();
        hasPremium = hasActiveSubscription(adaptyData);
      }
    }

    // Update app_metadata
    const updatedMetadata = {
      ...metadata,
      trialExpireDate: metadata.trialExpireDate ?? null,
      hasPremium: hasPremium,
      lastSubscriptionCheck: now,
    };

    const { error: updateError } = await supabase.auth.admin.updateUserById(uid, {
      app_metadata: updatedMetadata,
    });

    if (updateError) {
      console.error('Supabase update error:', updateError);
      return res.status(500).json({ error: 'Failed to update user metadata' });
    }

    return res.json({ updated: true, hasPremium });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Failed to update premium status' });
  }
});

function hasActiveSubscription(adaptyData) {
  if (!adaptyData?.data?.access_levels || !Array.isArray(adaptyData.data.access_levels)) {
    return false;
  }

  const now = new Date();

  return adaptyData.data.access_levels.some(level => {
    const startsAt = level.starts_at ? new Date(level.starts_at) : null;
    const expiresAt = level.expires_at ? new Date(level.expires_at) : null;

    // Если есть дата начала — проверяем, что уже началась
    const hasStarted = !startsAt || now >= startsAt;

    // Если есть дата окончания — проверяем, что ещё не закончилась
    const notExpired = !expiresAt || now <= expiresAt;

    return hasStarted && notExpired;
  });
}

app.post('/notify', async (req, res) => {
  const { accessToken, checklistId, userUids, content } = req.body;

  if (!accessToken || !userUids || !content) {
    return res.status(400).json({ error: 'Missing required fields: accessToken, userUids or content.' });
  }

  const { titles, messages } = content;
    if (!titles || !messages) {
    return res.status(400).json({ error: 'Missing content required fields: titles or messages.' });
  }

  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !user) {
      console.error('Auth error:', authError);
      return res.status(401).json({ error: 'Invalid token' });
    }

    const uid = user.id;
    const metadata = user.app_metadata || {};

    const now = Date.now();
    if (!metadata.hasPremium && (!metadata.trialExpireDate || now > metadata.trialExpireDate)) {
      return res.status(403).json({ error: 'User has no permissions.' });
    }

    const payload = {
      app_id: process.env.OS_APP_ID,
      include_external_user_ids: Array.from(userUids),
      headings: content["titles"],
      contents: content["messages"],
      android_channel_id: process.env.OS_ANDROID_CHANNEL_ID,
      thread_id: `${process.env.ANDROID_PACKAGE_NAME}.checklist_updates`,
      android_group: `${process.env.ANDROID_PACKAGE_NAME}.checklist_updates`,
    };

    if (checklistId != null) {
      payload.data = {
        checklistId: checklistId,
        collapse_id: checklistId,
      };
    }

    const r = await fetch(`${process.env.OS_API_BASE_URL}/notifications?c=push`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${process.env.OS_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    

    res.json(await r.json());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/ai/suggestions', async (req, res) => {
  const { idToken, title, items } = req.body;

  if (!idToken || !title || !items) {
    return res.status(400).json({ error: 'Missing required fields: idToken, title or items.' });
  }

  if (title.trim().length < 3) {
    return res.status(400).json({ error: 'Title must be at least 3 characters long.' });
  }

  const validItems = Array.isArray(items)
    ? items.filter(item => item && item.trim().length >= 2)
    : [];

  const hasItems = validItems.length > 0;
  // Min two items for full context
  const hasEnoughItems = validItems.length >= 2;

  try {
    // Verify the user's authentication token
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    // Check if user has premium access or is within trial period
    const now = Date.now();
    if (!decoded.hasPremium && (!decoded.trialExpireDate || now > decoded.trialExpireDate)) {
      return res.status(403).json({ error: 'User has no permissions for AI suggestions' });
    }

    // --- Prompt will be based on context ---
    let maxSuggestions;
    if (hasEnoughItems) {
      maxSuggestions = 10;
    } else {
      maxSuggestions = 5;
    }


    // Build prompt for AI suggestions
    const systemPrompt = 'You are a helpful AI assistant that provides intelligent suggestions for checklist management and productivity. Provide concise, actionable advice. Do not include hidden reasoning or <think> sections in your output. Return only a JSON array of suggested new items, without numbering or explanations.';
    let userPrompt = 'You are given a checklist with a title';
    if (hasItems) {
      userPrompt = userPrompt +  ` and some existing items. Suggest up to ${maxSuggestions} additional useful and practical items that logically complement the existing list, avoiding duplicates. Each item should be 1 short sentence. Title: ${title}.\nExisting items: ${validItems.join(', ')}.`;
    } else {
      userPrompt = userPrompt +  `. Suggest up to ${maxSuggestions} of the most essential and common items that are typically included for this type of checklist. Each item should be 1 short sentence. Title: ${title}.`;
    }

    const completion = await openai.chat.completions.create({
      user: uid,
      model: process.env.OR_MODEL_NAME,
      messages: [
        {
          "role": "system",
          "content": systemPrompt
        },
        {
          "role": "user",
          "content": userPrompt
        }
      ],
      temperature: 0.7,
      reasoning: {
        enabled: false,
        exclude: true,
      }
    });

    const rawSuggestions = completion.choices[0].message.content;

    if (!rawSuggestions) {
      return res.status(500).json({ error: 'Failed to generate AI suggestion' });
    }

    let suggestions = rawSuggestions.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    suggestions = suggestions.replace(/```json/g, "").replace(/```/g, "").trim();

    res.json({ 
      success: true, 
      suggestions
    });

  } catch (err) {
    console.error('AI suggestions error:', err);

    console.error(err.message);
    res.status(500).json({ error: err.message || 'Failed to generate AI suggestions' });
  }
});

app.post('/ai/parse', async (req, res) => {
  const { idToken, prompt } = req.body;

  if (!idToken || !prompt) {
    return res.status(400).json({ error: 'Missing required fields: idToken or prompt.' });
  }

  try {
    // Verify the user's authentication token
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    // Check if user has premium access or is within trial period
    const now = Date.now();
    if (!decoded.hasPremium && (!decoded.trialExpireDate || now > decoded.trialExpireDate)) {
      return res.status(403).json({ error: 'User has no permissions for AI suggestions' });
    }


    // Build prompt for AI suggestions
    const systemPrompt = 'You are a helpful assistant that extracts structured data from text. Rules: - Always return JSON only, without numbering or explanations; - JSON must have two fields: "title": string, "items": array of strings; - The title should be short (2–6 words max); - Items should be clear, concise, without duplicates; - If no items are detected, return an empty array. Do not include hidden reasoning or <think> sections in your output. Return only a JSON in format: {"title": "...", "items": ["...", "...", "..."]}, without numbering or explanations.';
    let userPrompt = `The user provides a single piece of transcribed text (from voice input) that includes both a checklist title and list items. Now process this input: ${prompt}`;


    const completion = await openai.chat.completions.create({
      user: uid,
      model: process.env.OR_MODEL_NAME,
      messages: [
        {
          "role": "system",
          "content": systemPrompt
        },
        {
          "role": "user",
          "content": userPrompt
        }
      ],
      temperature: 0.7,
      reasoning: {
        enabled: false,
        exclude: true,
      }
    });

    const rawSuggestions = completion.choices[0].message.content;
    // const rawSuggestions = '{"title": "Список покупок", "items": ["хлеб", "молока", "яйца"]}';

    if (!rawSuggestions) {
      return res.status(500).json({ error: 'Failed to generate AI suggestion' });
    }

    let suggestions = rawSuggestions.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    suggestions = suggestions.replace(/```json/g, "").replace(/```/g, "").trim();

    res.json({ 
      success: true, 
      suggestions
    });
  } catch (err) {
    console.error('AI suggestions error:', err);

    console.error(err.message);
    res.status(500).json({ error: err.message || 'Failed to generate AI suggestions' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
