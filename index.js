import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const SHOP = process.env.SHOPIFY_STORE_URL;
const TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const API_VERSION = '2025-07';
const GRAPHQL_ENDPOINT = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
const REST_ENDPOINT_BASE = `https://${SHOP}/admin/api/${API_VERSION}`;
const today = new Date();

let badgeRemovedCount = 0;
let metafieldDeletedCount = 0;
let updatedProducts = [];

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
            legacyResourceId
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

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN
    },
    body: JSON.stringify({ query, variables: { cursor } })
  });

  const result = await response.json();
  if (result.errors) {
    console.error("GraphQL errors:", result.errors);
    throw new Error("GraphQL query failed");
  }

  return result.data.products;
}

async function updateMetafield(productId, productTitle, newBadges) {
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

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN
    },
    body: JSON.stringify({ query: mutation, variables: { metafields } })
  });

  const result = await response.json();
  const errors = result.errors || result.data?.metafieldsSet?.userErrors || [];

  if (errors.length > 0) {
    console.error(`❌ Failed to update metafield for ${productTitle}:`, errors);
  } else {
    console.log(`✅ Removed 'New In' badge for: ${productTitle}`);
    badgeRemovedCount++;
    updatedProducts.push(`${productTitle} - Badge Removed`);
  }
}

async function deleteExpirationMetafield(productLegacyId, productTitle) {
  const url = `${REST_ENDPOINT_BASE}/products/${productLegacyId}/metafields.json`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`❌ Failed to fetch metafields for ${productTitle}: ${response.status} - ${errorText}`);
    return;
  }

  const data = await response.json();
  const metafield = data.metafields.find(mf => mf.namespace === 'custom' && mf.key === 'expiration_time');

  if (!metafield) {
    console.log(`ℹ️ No expiration_time metafield found for ${productTitle}`);
    return;
  }

  const deleteUrl = `${REST_ENDPOINT_BASE}/metafields/${metafield.id}.json`;

  const deleteResponse = await fetch(deleteUrl, {
    method: 'DELETE',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json'
    }
  });

  if (deleteResponse.ok) {
    console.log(`🗑️ Deleted expiration_time for: ${productTitle}`);
    metafieldDeletedCount++;
    updatedProducts.push(`${productTitle} - Expiration Removed`);
  } else {
    const err = await deleteResponse.text();
    console.error(`❌ Failed to delete expiration_time for ${productTitle}: ${deleteResponse.status} - ${err}`);
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
      const productLegacyId = product.legacyResourceId;
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

      if (isExpired && (hasNewIn || expirationRaw)) {
        if (hasNewIn) {
          const updatedBadges = badges.filter(b => b !== 'New In');
          console.log(`🛠 Updating ${product.title} - Removing 'New In' badge`);
          await updateMetafield(product.id, product.title, updatedBadges);
        }

        if (expirationRaw) {
          await deleteExpirationMetafield(productLegacyId, product.title);
        }

        found = true;
      } else {
        console.log(`ℹ️ Skipping ${product.title} - Expired: ${isExpired}, Has 'New In': ${hasNewIn}`);
      }
    }

    hasNextPage = products.pageInfo.hasNextPage;
    if (hasNextPage) {
      const lastEdge = products.edges[products.edges.length - 1];
      cursor = lastEdge?.cursor ?? null;
    }
  }

  console.log('\n🎯 Final Summary:');
  console.log(`✅ Products with 'New In' badge removed: ${badgeRemovedCount}`);
  console.log(`🗑️ Products with 'expiration_time' metafield deleted: ${metafieldDeletedCount}`);

  if (updatedProducts.length > 0) {
    console.log(`\n📦 Updated Products:`);
    updatedProducts.forEach((title, idx) => {
      console.log(`  ${idx + 1}. ${title}`);
    });
  }

  if (!found) {
    console.log("⚠️ No expired products with 'New In' badge found.");
  } else {
    console.log('✅ Badge and metafield cleanup completed.');
  }
}

removeBadge().catch(err => {
  console.error('❌ Script failed:', err);
});