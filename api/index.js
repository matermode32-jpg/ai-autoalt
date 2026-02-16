require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
const { restResources } = require('@shopify/shopify-api/rest/admin/2024-01');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// ==================== Supabase ====================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ==================== Shopify Client Factory ====================
function getShopifyClient(shopDomain, accessToken) {
  return new shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: ['read_products', 'write_products'],
    hostName: new URL(process.env.APP_URL).hostname,
    apiVersion: LATEST_API_VERSION,
    restResources,
  }).clients.Rest({ session: { shop: shopDomain, accessToken } });
}

// ==================== Helpers ====================
function verifyWebhook(req, hmacHeader) {
  const secret = process.env.SHOPIFY_API_SECRET;
  const hash = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('base64');
  return hash === hmacHeader;
}

function resizeImageUrl(url, size = '200x') {
  return url.replace(/\.(jpg|jpeg|png|gif|webp)/i, `_${size}.$1`);
}

async function checkUsage(shopDomain) {
  const today = new Date();
  const month = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];

  const { data: shop } = await supabase
    .from('shops')
    .select('plan, access_token')
    .eq('shop_domain', shopDomain)
    .single();

  if (!shop) {
    throw new Error('Shop not registered');
  }

  const { data: usage } = await supabase
    .from('usage_logs')
    .select('images_used')
    .eq('shop_domain', shopDomain)
    .eq('month', month)
    .maybeSingle();

  const used = usage?.images_used || 0;
  const limit = shop.plan === 'premium' ? 500 : 10;

  return { plan: shop.plan, used, limit, month, accessToken: shop.access_token };
}

async function incrementUsage(shopDomain, month, count = 1) {
  const { data: existing } = await supabase
    .from('usage_logs')
    .select('id, images_used')
    .eq('shop_domain', shopDomain)
    .eq('month', month)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('usage_logs')
      .update({ images_used: existing.images_used + count })
      .eq('id', existing.id);
  } else {
    await supabase
      .from('usage_logs')
      .insert({ shop_domain: shopDomain, month, images_used: count });
  }
}

async function generateAltText(imageUrl) {
  const resizedUrl = resizeImageUrl(imageUrl, '200x');

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.2-11b-vision-preview',
      messages: [
        {
          role: 'system',
          content: 'You are an SEO expert. Look at this product image and write a concise, descriptive Alt-Text (max 125 characters). Focus on material, color, and product type. No fluff or marketing words like "best" or "buy now".'
        },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: resizedUrl } },
            { type: 'text', text: 'Generate alt text for this product image.' }
          ]
        }
      ],
      max_tokens: 60,
      temperature: 0.3
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const alt = response.data.choices[0].message.content.trim();
  return alt.substring(0, 125);
}

async function processProduct(product, shopDomain, usage, client) {
  let processed = 0;
  for (const image of product.images) {
    if (image.alt && image.alt.trim() !== '') continue;
    if (usage.used + processed >= usage.limit) break;

    try {
      const newAlt = await generateAltText(image.src);
      await client.put({
        path: `products/${product.id}/images/${image.id}`,
        data: { image: { id: image.id, alt: newAlt } }
      });

      await supabase.from('alt_texts').insert({
        shop_domain: shopDomain,
        product_id: product.id,
        image_id: image.id,
        generated_alt: newAlt
      });

      processed++;
    } catch (err) {
      console.error(`Failed for image ${image.id}:`, err.message);
    }
  }
  return processed;
}

// ==================== Webhook: Product Create ====================
app.post('/api/webhooks/products/create', async (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const shopDomain = req.get('X-Shopify-Shop-Domain');

  if (!verifyWebhook(req, hmac)) {
    return res.status(401).send('Invalid signature');
  }

  try {
    const product = req.body;
    const usage = await checkUsage(shopDomain);
    const client = getShopifyClient(shopDomain, usage.accessToken);

    const processed = await processProduct(product, shopDomain, usage, client);

    if (processed > 0) {
      await incrementUsage(shopDomain, usage.month, processed);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error');
  }
});

// ==================== API: Manual Fix All ====================
app.post('/api/fix-alt', async (req, res) => {
  const shopDomain = req.body.shop || process.env.SHOPIFY_SHOP_DOMAIN;

  try {
    const usage = await checkUsage(shopDomain);
    if (usage.used >= usage.limit) {
      return res.status(403).json({
        error: `Monthly limit reached (${usage.limit} images). Upgrade to premium for 500 images/month.`
      });
    }

    const client = getShopifyClient(shopDomain, usage.accessToken);

    let products = [];
    let pageInfo;
    do {
      const response = await client.get({
        path: 'products',
        query: { limit: 250, fields: 'id,images,title' }
      });
      products = products.concat(response.body.products);
      pageInfo = response.pageInfo;
    } while (pageInfo?.nextPage);

    let totalProcessed = 0;
    for (const product of products) {
      const processed = await processProduct(product, shopDomain, usage, client);
      totalProcessed += processed;
      if (usage.used + totalProcessed >= usage.limit) break;
    }

    if (totalProcessed > 0) {
      await incrementUsage(shopDomain, usage.month, totalProcessed);
    }

    res.json({
      success: true,
      updated: totalProcessed,
      remaining: usage.limit - (usage.used + totalProcessed)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== API: Get Usage ====================
app.get('/api/usage', async (req, res) => {
  const shopDomain = req.query.shop || process.env.SHOPIFY_SHOP_DOMAIN;
  try {
    const { plan, used, limit } = await checkUsage(shopDomain);
    res.json({ plan, used, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Serve Frontend ====================
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: './public' });
});

module.exports = app;
// ... (all previous code) ...

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}
