import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const SHOP = process.env.SHOPIFY_STORE_URL;
const TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = '2024-07';
const ENDPOINT = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

async function fetchProducts(cursor = null) {
  const query = `
    query fetchProducts($cursor: String) {
      products(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
        }
        edges {
          cursor
          node {
            id
            title
            metafields(first: 10, namespace: "custom") {
              edges {
                node {
                  key
                  value
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN
    },
    body: JSON.stringify({
      query,
      variables: { cursor }
    })
  });

  const result = await response.json();
  if (result.errors) {
    throw new Error(JSON.stringify(result.errors, null, 2));
  }

  return result.data.products;
}

async function updateMetafield(productId, newBadges) {
  const mutation = `
    mutation updateProductMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          key
          value
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const metafields = [{
    namespace: 'custom',
    key: 'badges',
    type: 'list.single_line_text_field',
    value: JSON.stringify(newBadges),
    ownerId: productId
  }];

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN
    },
    body: JSON.stringify({
      query: mutation,
      variables: { metafields }
    })
  });

  const result = await response.json();
  const errors = result.errors || result.data?.metafieldsSet?.userErrors || [];

  if (errors.length > 0) {
    console.error(`❌ Failed to update metafield for ${productId}:`, errors);
  }
}

async function removeBadge() {
  console.log('🔍 Fetching products...');
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const products = await fetchProducts(cursor);
    if (!products || !products.edges) throw new Error("Invalid product response");

    for (const edge of products.edges) {
      const product = edge.node;
      const metafields = {};
      for (const { node } of product.metafields.edges) {
        metafields[node.key] = node.value;
      }

      const badges = metafields['badges'] ? JSON.parse(metafields['badges']) : [];
      const expirationDate = metafields['expiration_time'];

      const isExpired = expirationDate && new Date(expirationDate) < new Date(today);
      const hasNewIn = badges.includes('New In');

      if (isExpired && hasNewIn) {
        const updatedBadges = badges.filter(b => b !== 'New In');
        await updateMetafield(product.id, updatedBadges);
        console.log(`✅ Removed 'New In' from: ${product.title}`);
      }
    }

    hasNextPage = products.pageInfo.hasNextPage;
    if (hasNextPage) {
      cursor = products.edges[products.edges.length - 1].cursor;
    }
  }

  console.log('✅ All done.');
}

removeBadge().catch(err => {
  console.error('❌ Script failed:', err);
});