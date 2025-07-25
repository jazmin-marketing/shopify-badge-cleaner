import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const SHOP = process.env.SHOPIFY_STORE_URL;
const TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const API_VERSION = '2025-07';
const ENDPOINT = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

const today = new Date();

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
            metafields(first: 20, namespace: "custom") {
              edges {
                node {
                  key
                  type
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
    console.error("GraphQL errors:", result.errors);
    throw new Error("GraphQL query failed");
  }

  return result.data.products;
}

async function updateMetafield(productId, newBadges) {
  const mutation = `
    mutation updateProductMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
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
  } else {
    console.log(`✅ Metafield updated for product ${productId}`);
  }
}

async function removeBadge() {
  console.log('🔍 Fetching products...');
  let hasNextPage = true;
  let cursor = null;
  let found = false;

  while (hasNextPage) {
    const products = await fetchProducts(cursor);
    if (!products || !products.edges) {
      throw new Error("Invalid product response");
    }

    for (const edge of products.edges) {
      const product = edge.node;
      const metafieldMap = {};
      for (const { node } of product.metafields.edges) {
        metafieldMap[node.key] = node.value;
      }

      const badgesRaw = metafieldMap['badges'];
      const expirationRaw = metafieldMap['expiration_time'];

      const badges = badgesRaw ? JSON.parse(badgesRaw) : [];
      const hasNewIn = badges.includes('New In');

      let isExpired = false;
      if (expirationRaw) {
        const expDate = new Date(expirationRaw);
        isExpired = expDate < today;
      }

      if (isExpired && hasNewIn) {
        const updatedBadges = badges.filter(b => b !== 'New In');
        console.log(`🛠 Updating ${product.title} - Expired: ${expirationRaw}`);
        await updateMetafield(product.id, updatedBadges);
        found = true;
      } else {
        console.log(`ℹ️ Skipping ${product.title} - Expired: ${isExpired}, Has 'New In': ${hasNewIn}`);
      }
    }

    hasNextPage = products.pageInfo.hasNextPage;
    if (hasNextPage) {
      cursor = products.edges[products.edges.length - 1].cursor;
    }
  }

  if (!found) {
    console.log("⚠️ No products found with 'New In' + expired date.");
  } else {
    console.log('✅ All applicable products updated.');
  }
}

removeBadge().catch(err => {
  console.error('❌ Script failed:', err);
});